import { Config } from './config';
import { KubeConfig, CoreV1Api, V1PodList } from '@kubernetes/client-node';

export class K8sClient {
  client: any;
  k8sApi: CoreV1Api | undefined;

  constructor(private config: Config) {
    const kubeConfig = new KubeConfig();
    if (!config.k8sKubeConfig) {
      kubeConfig.loadFromCluster();
    } else {
      kubeConfig.loadFromFile(config.k8sKubeConfig);
    }
    this.k8sApi = kubeConfig.makeApiClient(CoreV1Api);
  }

  public async init() {
    // return await this.client.loadSpec();
  }

  public async getMongoServicePods(): Promise<V1PodList> {
    try {
      let result = new V1PodList();
      if (this.k8sApi) {
        result = (
          await this.k8sApi.listNamespacedPod(
            this.config.k8sNamespace,
            undefined,
            undefined,
            undefined,
            undefined,
            this.config.k8sMongoPodLabels
          )
        ).body;
      }
      return result;
    } catch (error) {
      console.log(`There was an error collecting the service pods ${error}`);
      return Promise.reject(error);
    }
  }

  private;
}
