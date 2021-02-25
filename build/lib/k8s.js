"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.K8sClient = void 0;
const client_node_1 = require("@kubernetes/client-node");
class K8sClient {
    constructor(config) {
        this.config = config;
        const kubeConfig = new client_node_1.KubeConfig();
        if (!config.k8sKubeConfig) {
            kubeConfig.loadFromCluster();
        }
        else {
            kubeConfig.loadFromFile(config.k8sKubeConfig);
        }
        this.k8sApi = kubeConfig.makeApiClient(client_node_1.CoreV1Api);
    }
    async init() {
        // return await this.client.loadSpec();
    }
    async getMongoServicePods() {
        try {
            let result = new client_node_1.V1PodList();
            if (this.k8sApi) {
                result = (await this.k8sApi.listNamespacedPod(this.config.k8sNamespace, undefined, undefined, undefined, undefined, this.config.k8sMongoPodLabels)).body;
            }
            return result;
        }
        catch (error) {
            console.log(`There was an error collecting the service pods ${error}`);
            return Promise.reject(error);
        }
    }
}
exports.K8sClient = K8sClient;
//# sourceMappingURL=k8s.js.map