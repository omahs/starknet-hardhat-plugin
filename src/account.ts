import {
    CallOptions,
    ContractInteractionFunction,
    DeployAccountOptions,
    EstimateFeeOptions,
    FeeEstimation,
    InteractChoice,
    InteractOptions,
    InvokeOptions,
    InvokeResponse,
    Numeric,
    StarknetContract,
    StringMap
} from "./types";
import { PLUGIN_NAME, TransactionHashPrefix } from "./constants";
import { HardhatPluginError } from "hardhat/plugins";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as ellipticCurve from "starknet/utils/ellipticCurve";
import { BigNumberish, toBN } from "starknet/utils/number";
import { ec } from "elliptic";
import {
    CallParameters,
    generateKeys,
    handleAccountContractArtifacts,
    parseMulticallOutput,
    signMultiCall
} from "./account-utils";
import { copyWithBigint } from "./utils";
import { Call, hash, RawCalldata } from "starknet";

type ExecuteCallParameters = {
    to: bigint;
    selector: BigNumberish;
    data_offset: number;
    data_len: number;
};

/**
 * Representation of an Account.
 * Multiple implementations can exist, each will be defined by an extension of this Abstract class
 */
export abstract class Account {
    protected constructor(
        public starknetContract: StarknetContract,
        public privateKey: string,
        public publicKey: string,
        public keyPair: ec.KeyPair,
        protected hre: HardhatRuntimeEnvironment
    ) {}

    /**
     * Uses the account contract as a proxy to invoke a function on the target contract with a signature
     *
     * @param toContract target contract to be called
     * @param functionName function in the contract to be called
     * @param calldata calldata to use as input for the contract call
     */
    async invoke(
        toContract: StarknetContract,
        functionName: string,
        calldata?: StringMap,
        options?: InvokeOptions
    ): Promise<InvokeResponse> {
        return (
            await this.interact(InteractChoice.INVOKE, toContract, functionName, calldata, options)
        ).toString();
    }

    get address() {
        return this.starknetContract.address;
    }

    /**
     * Uses the account contract as a proxy to call a function on the target contract with a signature
     *
     * @param toContract target contract to be called
     * @param functionName function in the contract to be called
     * @param calldata calldata to use as input for the contract call
     */
    async call(
        toContract: StarknetContract,
        functionName: string,
        calldata?: StringMap,
        options: CallOptions = {}
    ): Promise<StringMap> {
        if (this.hasRawOutput()) {
            options = copyWithBigint(options);
            options.rawOutput = true;
        }

        const { response } = <{ response: string[] }>(
            await this.interact(InteractChoice.CALL, toContract, functionName, calldata, options)
        );

        return toContract.adaptOutput(functionName, response.join(" "));
    }

    async estimateFee(
        toContract: StarknetContract,
        functionName: string,
        calldata?: StringMap,
        options?: EstimateFeeOptions
    ): Promise<FeeEstimation> {
        return await this.interact(
            InteractChoice.ESTIMATE_FEE,
            toContract,
            functionName,
            calldata,
            options
        );
    }

    private async interact(
        choice: InteractChoice,
        toContract: StarknetContract,
        functionName: string,
        calldata?: StringMap,
        options?: InteractOptions
    ) {
        const call: CallParameters = {
            functionName: functionName,
            toContract: toContract,
            calldata: calldata
        };

        return await this.multiInteract(choice, [call], options);
    }

    /**
     * Performs a multicall through this account
     * @param callParameters an array with the paramaters for each call
     * @returns an array with each call's repsecting response object
     */
    async multiCall(
        callParameters: CallParameters[],
        options: CallOptions = {}
    ): Promise<StringMap[]> {
        if (this.hasRawOutput()) {
            options = copyWithBigint(options);
            options.rawOutput = true;
        }

        const { response } = <{ response: string[] }>(
            await this.multiInteract(InteractChoice.CALL, callParameters, options)
        );
        const output: StringMap[] = parseMulticallOutput(response, callParameters);
        return output;
    }

    /**
     * Performes multiple invokes as a single transaction through this account
     * @param callParameters an array with the paramaters for each invoke
     * @returns the transaction hash of the invoke
     */
    async multiInvoke(callParameters: CallParameters[], options?: InvokeOptions): Promise<string> {
        // Invoke only returns one transaction hash, as the multiple invokes are done by the account contract, but only one is sent to it.
        return await this.multiInteract(InteractChoice.INVOKE, callParameters, options);
    }

    /**
     * Etimate the fee of the multicall.
     * @param callParameters an array with the parameters for each call
     * @returns the total estimated fee
     */
    async multiEstimateFee(
        callParameters: CallParameters[],
        options?: EstimateFeeOptions
    ): Promise<FeeEstimation> {
        return await this.multiInteract(InteractChoice.ESTIMATE_FEE, callParameters, options);
    }

    private async multiInteract(
        choice: InteractChoice,
        callParameters: CallParameters[],
        options: InteractOptions = {}
    ) {
        options = copyWithBigint(options);
        options.maxFee = BigInt(options?.maxFee || "0");
        const nonce = options.nonce || (await this.getNonce());
        delete options.nonce; // the options object is incompatible if passed on with nonce

        const { messageHash, args } = this.handleMultiInteract(
            this.starknetContract.address,
            callParameters,
            nonce,
            options.maxFee,
            choice.transactionVersion
        );

        if (options.signature) {
            const msg =
                "Custom signature cannot be specified when using Account (it is calculated automatically)";
            throw new HardhatPluginError(PLUGIN_NAME, msg);
        }
        const signatures = this.getSignatures(messageHash);
        const contractInteractOptions = { signature: signatures, ...options };

        const contractInteractor = (<ContractInteractionFunction>(
            this.starknetContract[choice.internalCommand]
        )).bind(this.starknetContract);
        const executionFunctionName = this.getExecutionFunctionName();
        return contractInteractor(executionFunctionName, args, contractInteractOptions);
    }

    /**
     * Prepares the calldata and hashes the message for the multicall execution
     *
     * @param accountAddress address of the account contract
     * @param callParameters array witht the call parameters
     * @param nonce current nonce
     * @param maxFee the maximum fee amoutn set for the contract interaction
     * @param version the transaction version
     * @param chainId the chain identifier
     * @param executionFunctionName the name of the cairo function that performs the execution
     * @returns the message hash for the multicall and the arguments to execute it with
     */
    private handleMultiInteract(
        accountAddress: string,
        callParameters: CallParameters[],
        nonce: Numeric,
        maxFee: Numeric,
        version: Numeric
    ) {
        const callArray: Call[] = callParameters.map((callParameters) => {
            return {
                contractAddress: callParameters.toContract.address,
                entrypoint: callParameters.functionName,
                calldata: callParameters.toContract.adaptInput(
                    callParameters.functionName,
                    callParameters.calldata
                )
            };
        });

        const executeCallArray: ExecuteCallParameters[] = [];
        const rawCalldata: RawCalldata = [];

        // Parse the Call array to create the objects which will be accepted by the contract
        callArray.forEach((call) => {
            executeCallArray.push({
                to: BigInt(call.contractAddress),
                selector: hash.starknetKeccak(call.entrypoint),
                data_offset: rawCalldata.length,
                data_len: call.calldata.length
            });
            rawCalldata.push(...call.calldata);
        });

        const adaptedNonce = nonce.toString();
        const adaptedMaxFee = "0x" + maxFee.toString(16);
        const adaptedVersion = "0x" + version.toString(16);
        const messageHash = this.getMessageHash(
            accountAddress,
            callArray,
            adaptedNonce,
            adaptedMaxFee,
            adaptedVersion
        );

        const args = {
            call_array: executeCallArray,
            calldata: rawCalldata,
            nonce: adaptedNonce
        };

        return { messageHash, args };
    }

    protected abstract getMessageHash(
        accountAddress: string,
        callArray: Call[],
        nonce: string,
        maxFee: string,
        version: string
    ): string;

    protected abstract getSignatures(messageHash: string): bigint[];

    protected abstract getExecutionFunctionName(): string;

    protected abstract getNonce(): Promise<bigint>;

    /**
     * Whether the execution method of this account returns raw output or not.
     */
    protected abstract hasRawOutput(): boolean;
}

/**
 * Wrapper for the OpenZeppelin implementation of an Account
 */
export class OpenZeppelinAccount extends Account {
    static readonly ACCOUNT_TYPE_NAME = "OpenZeppelinAccount";
    static readonly ACCOUNT_ARTIFACTS_NAME = "Account";
    static readonly VERSION = "0.1.0";

    constructor(
        starknetContract: StarknetContract,
        privateKey: string,
        publicKey: string,
        keyPair: ec.KeyPair,
        hre: HardhatRuntimeEnvironment
    ) {
        super(starknetContract, privateKey, publicKey, keyPair, hre);
    }

    protected getMessageHash(
        accountAddress: string,
        callArray: Call[],
        nonce: string,
        maxFee: string,
        version: string
    ): string {
        return hash.hashMulticall(accountAddress, callArray, nonce, maxFee, version);
    }

    protected getSignatures(messageHash: string): bigint[] {
        return signMultiCall(this.publicKey, this.keyPair, messageHash);
    }

    static async deployFromABI(
        hre: HardhatRuntimeEnvironment,
        options: DeployAccountOptions = {}
    ): Promise<OpenZeppelinAccount> {
        const contractPath = await handleAccountContractArtifacts(
            OpenZeppelinAccount.ACCOUNT_TYPE_NAME,
            OpenZeppelinAccount.ACCOUNT_ARTIFACTS_NAME,
            OpenZeppelinAccount.VERSION,
            hre
        );

        const signer = generateKeys(options.privateKey);

        const contractFactory = await hre.starknet.getContractFactory(contractPath);
        const contract = await contractFactory.deploy(
            { public_key: BigInt(signer.publicKey) },
            options
        );

        return new OpenZeppelinAccount(
            contract,
            signer.privateKey,
            signer.publicKey,
            signer.keyPair,
            hre
        );
    }

    static async getAccountFromAddress(
        address: string,
        privateKey: string,
        hre: HardhatRuntimeEnvironment
    ): Promise<OpenZeppelinAccount> {
        const contractPath = await handleAccountContractArtifacts(
            OpenZeppelinAccount.ACCOUNT_TYPE_NAME,
            OpenZeppelinAccount.ACCOUNT_ARTIFACTS_NAME,
            OpenZeppelinAccount.VERSION,
            hre
        );

        const contractFactory = await hre.starknet.getContractFactory(contractPath);
        const contract = contractFactory.getContractAt(address);

        const { res: expectedPubKey } = await contract.call("get_public_key");

        const keyPair = ellipticCurve.getKeyPair(toBN(privateKey.substring(2), "hex"));
        const publicKey = ellipticCurve.getStarkKey(keyPair);

        if (BigInt(publicKey) !== expectedPubKey) {
            throw new HardhatPluginError(
                PLUGIN_NAME,
                "The provided private key is not compatible with the public key stored in the contract."
            );
        }

        return new OpenZeppelinAccount(contract, privateKey, publicKey, keyPair, hre);
    }

    protected getExecutionFunctionName(): string {
        return "__execute__";
    }

    protected async getNonce(): Promise<bigint> {
        const { res: nonce } = await this.starknetContract.call("get_nonce");
        return nonce;
    }

    protected hasRawOutput(): boolean {
        return false;
    }
}

/**
 * Wrapper for the Argent implementation of an Account
 */
export class ArgentAccount extends Account {
    static readonly ACCOUNT_TYPE_NAME = "ArgentAccount";
    static readonly ACCOUNT_ARTIFACTS_NAME = "ArgentAccount";
    static readonly VERSION = "0.2.1";

    public guardianPublicKey: string;
    public guardianPrivateKey: string;
    public guardianKeyPair: ec.KeyPair;

    constructor(
        starknetContract: StarknetContract,
        privateKey: string,
        publicKey: string,
        keyPair: ec.KeyPair,
        guardianPrivateKey: string,
        guardianPublicKey: string,
        guardianKeyPair: ec.KeyPair,
        hre: HardhatRuntimeEnvironment
    ) {
        super(starknetContract, privateKey, publicKey, keyPair, hre);
        this.guardianPublicKey = guardianPublicKey;
        this.guardianPrivateKey = guardianPrivateKey;
        this.guardianKeyPair = guardianKeyPair;
    }

    protected getMessageHash(
        accountAddress: string,
        callArray: Call[],
        nonce: string,
        maxFee: string,
        version: string
    ): string {
        const hashable: Array<BigNumberish> = [callArray.length];
        const rawCalldata: RawCalldata = [];
        callArray.forEach((call) => {
            hashable.push(
                call.contractAddress,
                hash.starknetKeccak(call.entrypoint),
                rawCalldata.length,
                call.calldata.length
            );
            rawCalldata.push(...call.calldata);
        });

        const chainId = this.hre.config.starknet.networkConfig.starknetChainId;
        const adaptedChainId = BigInt("0x" + Buffer.from(chainId).toString("hex")).toString();

        hashable.push(rawCalldata.length, ...rawCalldata, nonce);
        const calldataHash = hash.computeHashOnElements(hashable);
        return hash.computeHashOnElements([
            TransactionHashPrefix.INVOKE,
            version,
            accountAddress,
            hash.getSelectorFromName(this.getExecutionFunctionName()),
            calldataHash,
            maxFee,
            adaptedChainId
        ]);
    }

    protected getSignatures(messageHash: string): bigint[] {
        const signerSignatures = signMultiCall(this.publicKey, this.keyPair, messageHash);
        const guardianSignatures = signMultiCall(
            this.guardianPublicKey,
            this.guardianKeyPair,
            messageHash
        );
        return signerSignatures.concat(guardianSignatures);
    }

    /**
     * Updates the guardian key in the contract
     * @param newGuardianPrivateKey private key of the guardian to update
     * @returns
     */
    async setGuardian(newGuardianPrivateKey: string): Promise<string> {
        const guardianKeyPair = ellipticCurve.getKeyPair(
            toBN(newGuardianPrivateKey.substring(2), "hex")
        );
        const guardianPublicKey = ellipticCurve.getStarkKey(guardianKeyPair);

        this.guardianPrivateKey = newGuardianPrivateKey;
        this.guardianPublicKey = guardianPublicKey;
        this.guardianKeyPair = guardianKeyPair;

        const call: CallParameters = {
            functionName: "change_guardian",
            toContract: this.starknetContract,
            calldata: { new_guardian: BigInt(guardianPublicKey) }
        };

        return await this.multiInvoke([call]);
    }

    static async deployFromABI(
        hre: HardhatRuntimeEnvironment,
        options: DeployAccountOptions = {}
    ): Promise<ArgentAccount> {
        const contractPath = await handleAccountContractArtifacts(
            ArgentAccount.ACCOUNT_TYPE_NAME,
            ArgentAccount.ACCOUNT_ARTIFACTS_NAME,
            ArgentAccount.VERSION,
            hre
        );

        const signer = generateKeys(options.privateKey);
        const guardian = generateKeys();

        const contractFactory = await hre.starknet.getContractFactory(contractPath);
        const contract = await contractFactory.deploy({}, options);

        await contract.invoke("initialize", {
            signer: BigInt(signer.publicKey),
            guardian: BigInt(guardian.publicKey)
        });

        return new ArgentAccount(
            contract,
            signer.privateKey,
            signer.publicKey,
            signer.keyPair,
            guardian.privateKey,
            guardian.publicKey,
            guardian.keyPair,
            hre
        );
    }

    static async getAccountFromAddress(
        address: string,
        privateKey: string,
        hre: HardhatRuntimeEnvironment
    ): Promise<ArgentAccount> {
        const contractPath = await handleAccountContractArtifacts(
            ArgentAccount.ACCOUNT_TYPE_NAME,
            ArgentAccount.ACCOUNT_ARTIFACTS_NAME,
            ArgentAccount.VERSION,
            hre
        );

        const contractFactory = await hre.starknet.getContractFactory(contractPath);
        const contract = contractFactory.getContractAt(address);

        const { signer: expectedPubKey } = await contract.call("get_signer");
        const keyPair = ellipticCurve.getKeyPair(toBN(privateKey.substring(2), "hex"));
        const publicKey = ellipticCurve.getStarkKey(keyPair);

        if (BigInt(publicKey) !== expectedPubKey) {
            throw new HardhatPluginError(
                PLUGIN_NAME,
                "The provided private key is not compatible with the public key stored in the contract."
            );
        }

        return new ArgentAccount(contract, privateKey, publicKey, keyPair, "0", "0", null, hre);
    }

    protected getExecutionFunctionName(): string {
        return "__execute__";
    }

    protected async getNonce(): Promise<bigint> {
        const { nonce } = await this.starknetContract.call("get_nonce");
        return nonce;
    }

    protected hasRawOutput(): boolean {
        return true;
    }
}
