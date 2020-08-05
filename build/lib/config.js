'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _this = this;
var dns = require('dns');
var promisify = require('util').promisify;
var getK8sROServiceAddress = function () { return process.env.KUBERNETES_SERVICE_HOST + ":" + process.env.KUBERNETES_SERVICE_PORT; };
/**
 * @returns k8sClusterDomain should the name of the kubernetes domain where the cluster is running.
 * Can be convigured via the environmental variable 'KUBERNETES_CLUSTER_DOMAIN'.
 */
var getK8sClusterDomain = function () {
    var domain = process.env.KUBERNETES_CLUSTER_DOMAIN || 'cluster.local';
    verifyCorrectnessOfDomain(domain);
    return domain;
};
/**
 * Calls a reverse DNS lookup to ensure that the given custom domain name matches the actual one.
 * Raises a console warning if that is not the case.
 * @param clusterDomain the domain to verify.
 */
var verifyCorrectnessOfDomain = function (clusterDomain) { return __awaiter(_this, void 0, void 0, function () {
    var servers, reverse, host, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                if (!clusterDomain)
                    return [2 /*return*/];
                servers = dns.getServers();
                if (!servers || !servers.length) {
                    console.warn('dns.getServers() didn\'t return any results when verifying the cluster domain \'%s\'.', clusterDomain);
                    return [2 /*return*/];
                }
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                reverse = promisify(dns.reverse);
                return [4 /*yield*/, reverse(servers[0])];
            case 2:
                host = _a.sent();
                if (host.length < 1 || !host[0].endsWith(clusterDomain)) {
                    console.warn('Possibly wrong cluster domain name! Detected \'%s\' but expected similar to \'%s\'', clusterDomain, host);
                }
                else {
                    console.info('The cluster domain \'%s\' was successfully verified.', clusterDomain);
                }
                return [3 /*break*/, 4];
            case 3:
                err_1 = _a.sent();
                console.warn('Error occurred trying to verify the cluster domain \'%s\'', clusterDomain);
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); };
/**
 * @returns k8sMongoServiceName should be the name of the (headless) k8s service operating the mongo pods.
 */
var getK8sMongoServiceName = function () { return process.env.KUBERNETES_SERVICE_NAME || 'mongo'; };
/**
 * @returns mongoPort this is the port on which the mongo instances run. Default is 27017.
 */
var getMongoPort = function () {
    var mongoPort = process.env.MONGO_PORT || 27017;
    console.info('Using mongo port: %s', mongoPort);
    return mongoPort;
};
/**
 *  @returns boolean to define the RS as a configsvr or not. Default is false
 */
var isConfigRS = function () {
    var configSvr = (process.env.MONGO_CONFIG_SVR || '').trim().toLowerCase();
    var configSvrBool = /^(?:y|yes|true|1)$/i.test(configSvr);
    if (configSvrBool) {
        console.info('ReplicaSet is configured as a configsvr');
    }
    return configSvrBool;
};
/**
 * @returns boolean
 */
var stringToBool = function (boolStr) { return (boolStr === 'true') || false; };
module.exports = {
    k8sNamespace: process.env.KUBERNETES_NAMESPACE,
    k8sClusterDomain: getK8sClusterDomain(),
    k8sROServiceAddress: getK8sROServiceAddress(),
    k8sMongoServiceName: getK8sMongoServiceName(),
    k8sMongoPodLabels: process.env.KUBERNETES_POD_LABELS,
    mongoPort: getMongoPort(),
    mongoDatabase: process.env.MONGO_DATABASE || 'local',
    mongoUsername: process.env.MONGO_USERNAME,
    mongoPassword: process.env.MONGO_PASSWORD,
    mongoAuthSource: process.env.MONGO_AUTH_SOURCE || 'admin',
    authMechanism: process.env.MONGO_AUTH_MECHANISM || 'SCRAM-SHA-1',
    mongoTLS: stringToBool(process.env.MONGO_TLS),
    mongoTLSCA: process.env.MONGO_TLS_CA,
    mongoTLSCert: process.env.MONGO_TLS_CERT,
    mongoTLSKey: process.env.MONGO_TLS_KEY,
    mongoTLSPassword: process.env.MONGO_TLS_PASS,
    mongoTLSCRL: process.env.MONGO_TLS_CRL,
    mongoTLSServerIdentityCheck: stringToBool(process.env.MONGO_TLS_IDENTITY_CHECK),
    loopSleepSeconds: process.env.SIDECAR_SLEEP_SECONDS || 5,
    unhealthySeconds: process.env.SIDECAR_UNHEALTHY_SECONDS || 15,
    env: process.env.NODE_ENV || 'local',
    isConfigRS: isConfigRS(),
};
