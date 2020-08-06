"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = void 0;
const common_1 = require("./common");
const dns_1 = require("dns");
const util_1 = require("util");
class Config {
    constructor() {
        this.isClusterVerified = false;
    }
    get debug() {
        return common_1.Common.stringToBool(process.env.MONGO_DEBUG || '');
    }
    get k8sKubeConfig() {
        return process.env.KUBERNETES_KUBECONFIG || '';
    }
    get k8sNamespace() {
        return process.env.KUBERNETES_NAMESPACE || '';
    }
    get k8sClusterDomain() {
        return this.getK8sClusterDomain();
    }
    get k8sROServiceAddress() {
        return this.getK8sRoServiceAddress();
    }
    get k8sMongoServiceName() {
        return this.getK8sMongoServiceName();
    }
    get k8sMongoPodLabels() {
        return process.env.KUBERNETES_POD_LABELS;
    }
    get mongoPort() {
        return this.getMongoPort();
    }
    get mongoDatabase() {
        return process.env.MONGO_DATABASE || 'local';
    }
    get mongoUsername() {
        return process.env.MONGO_USERNAME;
    }
    get mongoPassword() {
        return process.env.MONGO_PASSWORD;
    }
    get mongoAuthSource() {
        return process.env.MONGO_AUTH_SOURCE || 'admin';
    }
    get authMechanism() {
        return process.env.MONGO_AUTH_MECHANISM || 'SCRAM-SHA-1';
    }
    get mongoSSL() {
        return common_1.Common.stringToBool(process.env.MONGO_SSL || '');
    }
    get mongoTLS() {
        return common_1.Common.stringToBool(process.env.MONGO_TLS || '');
    }
    get mongoTLSCA() {
        return process.env.MONGO_TLS_CA;
    }
    get mongoTLSCert() {
        return process.env.MONGO_TLS_CERT;
    }
    get mongoTLSKey() {
        return process.env.MONGO_TLS_KEY;
    }
    get mongoTLSPassword() {
        return process.env.MONGO_TLS_PASS;
    }
    get mongoTLSCRL() {
        return process.env.MONGO_TLS_CRL;
    }
    get mongoTLSServerIdentityCheck() {
        return common_1.Common.stringToBool(process.env.MONGO_TLS_IDENTITY_CHECK || '');
    }
    get loopSleepSeconds() {
        let result = 5;
        if (process.env.SIDECAR_SLEEP_SECONDS) {
            result = Number.parseInt(process.env.SIDECAR_SLEEP_SECONDS, 10);
            if (!result || result < 0) {
                result = 5;
            }
        }
        return result;
    }
    get unhealthySeconds() {
        let result = 15;
        if (process.env.SIDECAR_UNHEALTHY_SECONDS) {
            result = Number.parseInt(process.env.SIDECAR_UNHEALTHY_SECONDS, 10);
            if (!result || result < 0) {
                result = 15;
            }
        }
        return result;
    }
    get env() {
        return process.env.NODE_ENV || 'local';
    }
    get isConfigRS() {
        return this.isConfigRs();
    }
    getK8sRoServiceAddress() {
        return `${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
    }
    getK8sClusterDomain() {
        const domain = process.env.KUBERNETES_CLUSTER_DOMAIN || 'cluster.local';
        this.verifyClusterDomain(domain);
        return domain;
    }
    async verifyClusterDomain(clusterDomain) {
        if (!clusterDomain)
            return;
        if (this.isClusterVerified)
            return;
        const servers = dns_1.getServers();
        if (!servers || !servers.length) {
            // console.warn(`dns: Didn't find any result when verifying the cluster domain ${clusterDomain}`);
        }
        try {
            const dnsReverse = util_1.promisify(dns_1.reverse);
            const host = await dnsReverse(servers[0]);
            if (host.length < 1 || !host[0].endsWith(clusterDomain)) {
                // console.warn(`Possibly wrong cluster domain name! Detected ${clusterDomain} but expected similar to ${host}`);
            }
            else {
                // console.info(`The cluster domain ${clusterDomain} was successfully verified.`);
            }
        }
        catch (err) {
            // console.warn(`Error occurred trying to verify the cluster domain ${clusterDomain}`);
        }
        return;
    }
    getK8sMongoServiceName() {
        let serviceName = process.env.KUBERNETES_SERVICE_NAME;
        if (!serviceName) {
            // console.info(`No service was defined, using default "mongo" as the name`);
            serviceName = 'mongo';
        }
        return serviceName;
    }
    getMongoPort() {
        let mongoPort = process.env.MONGO_PORT;
        if (!mongoPort) {
            // console.info(`No port was defined, using mongo default 27017 as the port`);
            mongoPort = '27017';
        }
        // console.info('Using mongo port: %s', mongoPort);
        return mongoPort;
    }
    isConfigRs() {
        const configSvr = common_1.Common.stringToBool(process.env.MONGO_CONFIG_SVR || '');
        if (configSvr) {
            // console.info('ReplicaSet is configured as a configsvr');
        }
        return configSvr;
    }
}
exports.Config = Config;
//# sourceMappingURL=config.js.map