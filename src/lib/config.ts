import { Common } from './common';
import { reverse, getServers } from 'dns';
import { promisify } from 'util';

export class Config {
  private isClusterVerified = false;

  get debug(): boolean {
    return Common.stringToBool(process.env.MONGO_DEBUG || '');
  }
  get k8sKubeConfig(): string {
    return process.env.KUBERNETES_KUBECONFIG || '';
  }

  get k8sNamespace(): string {
    return process.env.KUBERNETES_NAMESPACE || '';
  }

  get k8sClusterDomain(): string | undefined {
    return this.getK8sClusterDomain();
  }

  get k8sROServiceAddress(): string | undefined {
    return this.getK8sRoServiceAddress();
  }

  get k8sMongoServiceName(): string {
    return this.getK8sMongoServiceName();
  }

  get k8sMongoPodLabels(): string | undefined {
    return process.env.KUBERNETES_POD_LABELS;
  }

  get mongoPort(): string {
    return this.getMongoPort();
  }

  get mongoDatabase(): string {
    return process.env.MONGO_DATABASE || 'local';
  }

  get mongoUsername(): string | undefined {
    return process.env.MONGO_USERNAME;
  }

  get mongoPassword(): string | undefined {
    return process.env.MONGO_PASSWORD;
  }

  get mongoAuthSource(): string {
    return process.env.MONGO_AUTH_SOURCE || 'admin';
  }

  get authMechanism(): string {
    return process.env.MONGO_AUTH_MECHANISM || 'SCRAM-SHA-1';
  }

  get mongoSSL(): boolean {
    return Common.stringToBool(process.env.MONGO_SSL || '');
  }

  get mongoTLS(): boolean {
    return Common.stringToBool(process.env.MONGO_TLS || '');
  }

  get mongoTLSCA(): string | undefined {
    return process.env.MONGO_TLS_CA;
  }

  get mongoTLSCert(): string | undefined {
    return process.env.MONGO_TLS_CERT;
  }

  get mongoTLSKey(): string | undefined {
    return process.env.MONGO_TLS_KEY;
  }

  get mongoTLSPassword(): string | undefined {
    return process.env.MONGO_TLS_PASS;
  }

  get mongoTLSCRL(): string | undefined {
    return process.env.MONGO_TLS_CRL;
  }

  get mongoTLSServerIdentityCheck(): boolean {
    return Common.stringToBool(process.env.MONGO_TLS_IDENTITY_CHECK || '');
  }

  get loopSleepSeconds(): number {
    let result = 5;
    if (process.env.SIDECAR_SLEEP_SECONDS) {
      result = Number.parseInt(process.env.SIDECAR_SLEEP_SECONDS, 10);
      if (!result || result < 0) {
        result = 5;
      }
    }

    return result;
  }

  get unhealthySeconds(): number {
    let result = 15;
    if (process.env.SIDECAR_UNHEALTHY_SECONDS) {
      result = Number.parseInt(process.env.SIDECAR_UNHEALTHY_SECONDS, 10);
      if (!result || result < 0) {
        result = 15;
      }
    }

    return result;
  }

  get env(): string {
    return process.env.NODE_ENV || 'local';
  }

  get isConfigRS(): boolean {
    return this.isConfigRs();
  }

  private getK8sRoServiceAddress(): string {
    return `${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
  }

  private getK8sClusterDomain(): string {
    const domain = process.env.KUBERNETES_CLUSTER_DOMAIN || 'cluster.local';
    this.verifyClusterDomain(domain);
    return domain;
  }

  private async verifyClusterDomain(clusterDomain: string) {
    if (!clusterDomain) return;
    if (this.isClusterVerified) return;

    const servers = getServers();

    if (!servers || !servers.length) {
      // console.warn(`dns: Didn't find any result when verifying the cluster domain ${clusterDomain}`);
    }

    try {
      const dnsReverse = promisify(reverse);
      const host = await dnsReverse(servers[0]);
      if (host.length < 1 || !host[0].endsWith(clusterDomain)) {
        // console.warn(`Possibly wrong cluster domain name! Detected ${clusterDomain} but expected similar to ${host}`);
      } else {
        // console.info(`The cluster domain ${clusterDomain} was successfully verified.`);
      }
    } catch (err) {
      // console.warn(`Error occurred trying to verify the cluster domain ${clusterDomain}`);
    }

    return;
  }

  private getK8sMongoServiceName(): string {
    let serviceName = process.env.KUBERNETES_SERVICE_NAME;
    if (!serviceName) {
      // console.info(`No service was defined, using default "mongo" as the name`);
      serviceName = 'mongo';
    }
    return serviceName;
  }

  private getMongoPort(): string {
    let mongoPort = process.env.MONGO_PORT;
    if (!mongoPort) {
      // console.info(`No port was defined, using mongo default 27017 as the port`);
      mongoPort = '27017';
    }
    // console.info('Using mongo port: %s', mongoPort);
    return mongoPort;
  }

  private isConfigRs(): boolean {
    const configSvr = Common.stringToBool(process.env.MONGO_CONFIG_SVR || '');
    if (configSvr) {
      // console.info('ReplicaSet is configured as a configsvr');
    }

    return configSvr;
  }
}
