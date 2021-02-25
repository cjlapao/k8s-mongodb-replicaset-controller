import { PodMember } from './../models/PodMember';
import { Config } from './../config';
import { V1Pod } from '@kubernetes/client-node';
export class PodHelper {
  constructor(private config: Config) {}

  /**
   * Electing a master pod to rule them all, based on their creation date
   * we will elect as primary the oldest of them all
   * @param {*} pods
   * @returns {string} address - Kubernetes pod's address
   */
  public electMasterPod(pods: PodMember[]) {
    pods.sort((a, b) => {
      const aDate = a.k8sPod?.metadata?.creationTimestamp;
      const bDate = b.k8sPod?.metadata?.creationTimestamp;
      if (!aDate < !bDate) return -1;
      if (!aDate > !bDate) return 1;
      return 0; // Shouldn't get here... all pods should have different dates
    });
    return this.getPodAddress(pods[0].k8sPod);
  }

  /**
   * Gets the pod's address. It can be either in the form of
   * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'.
   * If those are not set, then simply the pod's IP is returned.
   * @param {*} pod Kubernetes Pod
   * @returns string - Kubernetes stateful set address or pod's IP
   */
  private getPodAddress(pod: V1Pod | undefined): string {
    let address: any;
    address = this.getPodStableNetworkAddressAndPort(pod);
    if (!address) {
      console.warn(`Could not find the stable network address for the pod ${pod?.metadata?.name}`);
      address = this.getPodIpAddressAndPort(pod);
    }
    if (this.config.mongoDbExternalDomain) {
      const urlSegments = address.split('.');
      if (urlSegments.length > 0) {
        address = `${urlSegments[0]}.${this.config.mongoDbExternalDomain}`;
      }
    }

    return address;
  }

  /**
   * Gets the pod's IP Address and the mongo port
   * @param pod this is the Kubernetes pod, containing the info.
   * @returns string - podIp the pod's IP address with the port from config attached at the end. Example
   * WWW.XXX.YYY.ZZZ:27017. It returns undefined, if the data is insufficient to retrieve the IP address.
   */
  private getPodIpAddressAndPort(pod: V1Pod | undefined): string | undefined {
    if (!pod || !pod.status || !pod.status.podIP) return;

    return `${pod.status.podIP}:${this.config.mongoPort}`;
  }

  /**
   * Gets the pod's address. It can be either in the form of
   * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'. See:
   * <a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">Stateful Set documentation</a>
   * for more details.
   * @param pod the Kubernetes pod, containing the information from the k8s client.
   * @returns string the k8s MongoDB stable network address, or undefined.
   */
  private getPodStableNetworkAddressAndPort(pod: V1Pod | undefined): string | undefined {
    if (!this.config.k8sMongoServiceName || !pod || !pod.metadata || !pod.metadata.name || !pod.metadata.namespace)
      return;

    return `${pod.metadata.name}.${this.config.k8sMongoServiceName}.${pod.metadata.namespace}.svc.${this.config.k8sClusterDomain}:${this.config.mongoPort}`;
  }

  public toPodMember(pod: V1Pod | undefined): PodMember {
    if (pod) {
      return {
        change: 'ADD',
        k8sPod: pod,
        ip: pod.status?.podIP,
        host: this.getPodAddress(pod),
        isRunning: pod.status?.phase === 'Running' && pod.status?.podIP ? true : false,
      };
    }
    return {};
  }
}
