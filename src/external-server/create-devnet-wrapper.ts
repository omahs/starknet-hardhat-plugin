import { HardhatNetworkConfig, HardhatRuntimeEnvironment } from "hardhat/types";
import { StarknetPluginError } from "../starknet-plugin-error";

import {
    DEFAULT_DEVNET_DOCKER_IMAGE_TAG,
    DEVNET_DOCKER_REPOSITORY,
    INTEGRATED_DEVNET,
    INTEGRATED_DEVNET_URL
} from "../constants";
import { getImageTagByArch, getNetwork } from "../utils";
import { DockerDevnet } from "./docker-devnet";
import { VenvDevnet } from "./venv-devnet";
import { ExternalServer, getFreePort } from "./external-server";

export async function createIntegratedDevnet(hre: HardhatRuntimeEnvironment): Promise<ExternalServer> {
    const devnetNetwork = getNetwork<HardhatNetworkConfig>(
        INTEGRATED_DEVNET,
        hre.config.networks,
        `networks["${INTEGRATED_DEVNET}"]`
    );
    const { hostname } = new URL(devnetNetwork.url || INTEGRATED_DEVNET_URL);
    const port = await getFreePort();

    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        throw new StarknetPluginError("Integrated devnet works only with localhost and 127.0.0.1");
    }

    if (devnetNetwork.venv) {
        return new VenvDevnet(
            devnetNetwork.venv,
            hostname,
            port,
            devnetNetwork?.args,
            devnetNetwork?.stdout,
            devnetNetwork?.stderr
        );
    }

    if (hostname === "localhost") {
        throw new StarknetPluginError(
            "Dockerized integrated devnet works only with host 127.0.0.1"
        );
    }

    const tag = getImageTagByArch(
        devnetNetwork.dockerizedVersion || DEFAULT_DEVNET_DOCKER_IMAGE_TAG
    );
    return new DockerDevnet(
        {
            repository: DEVNET_DOCKER_REPOSITORY,
            tag
        },
        hostname,
        port,
        devnetNetwork?.args,
        devnetNetwork?.stdout,
        devnetNetwork?.stderr
    );
}