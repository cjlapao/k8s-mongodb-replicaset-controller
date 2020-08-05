/* eslint require-atomic-updates: 0 */
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
var fs = require('fs');
var promisify = require('util').promisify;
var MongoClient = require('mongodb').MongoClient;
var config = require('./config');
var localhost = '127.0.0.1'; // Can access mongo as localhost from a sidecar
var certificates = null;
var getConnectionURI = function (host) {
    var credentials = '';
    if (config.mongoUsername) {
        var username = encodeURIComponent(config.mongoUsername);
        var password = encodeURIComponent(config.mongoPassword);
        credentials = username + ":" + password + "@";
    }
    return "mongodb://" + credentials + host + ":" + config.mongoPort + "/" + config.mongoDatabase;
};
var getTLSCertificates = function () { return __awaiter(_this, void 0, void 0, function () {
    var readFile, tasks, files, certs, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                readFile = promisify(fs.readFile);
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                tasks = [];
                if (config.mongoTLSCert)
                    tasks[0] = readFile(config.mongoTLSCert);
                if (config.mongoTLSKey)
                    tasks[1] = readFile(config.mongoTLSKey);
                if (config.mongoTLSCA)
                    tasks[2] = readFile(config.mongoTLSCA);
                if (config.mongoTLSCRL)
                    tasks[3] = readFile(config.mongoTLSCRL);
                return [4 /*yield*/, Promise.all(tasks)];
            case 2:
                files = _a.sent();
                certs = {};
                if (files[0])
                    certs.sslCert = files[0];
                if (files[1])
                    certs.sslKey = files[1];
                if (files[2])
                    certs.sslCA = files[2];
                if (files[3])
                    certs.sslCRL = files[3];
                return [2 /*return*/, certs];
            case 3:
                err_1 = _a.sent();
                return [2 /*return*/, Promise.reject(err_1)];
            case 4: return [2 /*return*/];
        }
    });
}); };
var getClient = function (host) { return __awaiter(_this, void 0, void 0, function () {
    var options, _a, uri, client, err_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                host = host || localhost;
                options = {
                    authSource: config.mongoAuthSource,
                    authMechanism: config.mongoUsername ? config.authMechanism : '',
                    ssl: config.mongoTLS,
                    sslPass: config.mongoTLSPassword,
                    checkServerIdentity: config.mongoTLSServerIdentityCheck,
                    useNewUrlParser: true,
                    useUnifiedTopology: true,
                };
                _b.label = 1;
            case 1:
                _b.trys.push([1, 5, , 6]);
                if (!config.mongoTLS) return [3 /*break*/, 4];
                _a = certificates;
                if (_a) return [3 /*break*/, 3];
                return [4 /*yield*/, getTLSCertificates()];
            case 2:
                _a = (_b.sent());
                _b.label = 3;
            case 3:
                certificates = _a;
                Object.assign(options, certificates);
                _b.label = 4;
            case 4:
                uri = getConnectionURI(host);
                client = new MongoClient(uri, options);
                return [2 /*return*/, client.connect()];
            case 5:
                err_2 = _b.sent();
                return [2 /*return*/, Promise.reject(err_2)];
            case 6: return [2 /*return*/];
        }
    });
}); };
var replSetGetConfig = function (db) {
    return db
        .admin()
        .command({ replSetGetConfig: 1 }, {})
        .then(function (results) { return results.config; });
};
// Gets the current status of the client
var replSetGetStatus = function (db) { return __awaiter(_this, void 0, void 0, function () {
    var status, result, err_3;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                status = {
                    set: undefined,
                    ok: undefined,
                    code: undefined,
                    members: [],
                };
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                console.log('Checking replicaSet status');
                return [4 /*yield*/, db.admin().command({ replSetGetStatus: {} }, {})];
            case 2:
                result = _a.sent();
                status.set = result.set;
                status.ok = result.ok;
                status.code = 0;
                if (result.members) {
                    status.members = result.members;
                }
                else {
                    status.members = [];
                }
                return [2 /*return*/, status];
            case 3:
                err_3 = _a.sent();
                status.ok = 0;
                status.code = err_3.code;
                return [2 /*return*/, status];
            case 4: return [2 /*return*/];
        }
    });
}); };
var initReplSet = function (db, hostIpAndPort) { return __awaiter(_this, void 0, void 0, function () {
    var rsConfig, times, interval, wait, tries, err_4, err_5;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                console.info('initReplSet', hostIpAndPort);
                _a.label = 1;
            case 1:
                _a.trys.push([1, 11, , 12]);
                return [4 /*yield*/, db.admin().command({ replSetInitiate: {} }, {})];
            case 2:
                _a.sent();
                return [4 /*yield*/, replSetGetConfig(db)];
            case 3:
                rsConfig = _a.sent();
                console.info('initial rsConfig is', rsConfig);
                rsConfig.configsvr = config.isConfigRS;
                rsConfig.members[0].host = hostIpAndPort;
                times = 20;
                interval = 500;
                wait = function (time) { return new Promise(function (resolve) { return setTimeout(resolve, time); }); };
                tries = 0;
                _a.label = 4;
            case 4:
                if (!(tries < times)) return [3 /*break*/, 10];
                _a.label = 5;
            case 5:
                _a.trys.push([5, 7, , 9]);
                return [4 /*yield*/, replSetReconfig(db, rsConfig, false)];
            case 6: return [2 /*return*/, _a.sent()];
            case 7:
                err_4 = _a.sent();
                return [4 /*yield*/, wait(interval)];
            case 8:
                _a.sent();
                tries++;
                if (tries >= times)
                    return [2 /*return*/, Promise.reject(err_4)];
                return [3 /*break*/, 9];
            case 9: return [3 /*break*/, 4];
            case 10: return [3 /*break*/, 12];
            case 11:
                err_5 = _a.sent();
                return [2 /*return*/, Promise.reject(err_5)];
            case 12: return [2 /*return*/];
        }
    });
}); };
var replSetReconfig = function (db, rsConfig, force) {
    console.info('replSetReconfig', rsConfig);
    rsConfig.version++;
    return db.admin().command({ replSetReconfig: rsConfig, force: force }, {});
};
var addNewReplSetMembers = function (db, addrToAdd, addrToRemove, shouldForce) { return __awaiter(_this, void 0, void 0, function () {
    var rsConfig, err_6;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, replSetGetConfig(db)];
            case 1:
                rsConfig = _a.sent();
                removeDeadMembers(rsConfig, addrToRemove);
                addNewMembers(rsConfig, addrToAdd);
                return [2 /*return*/, replSetReconfig(db, rsConfig, shouldForce)];
            case 2:
                err_6 = _a.sent();
                return [2 /*return*/, Promise.reject(err_6)];
            case 3: return [2 /*return*/];
        }
    });
}); };
var addNewMembers = function (rsConfig, addrsToAdd) {
    if (!addrsToAdd || !addrsToAdd.length)
        return;
    // Follows what is basically in mongo's rs.add function
    var max = 0;
    for (var _i = 0, _a = rsConfig.members; _i < _a.length; _i++) {
        var members = _a[_i];
        if (members._id > max) {
            max = members._id;
        }
    }
    for (var _b = 0, addrsToAdd_1 = addrsToAdd; _b < addrsToAdd_1.length; _b++) {
        var addr = addrsToAdd_1[_b];
        // Somehow we can get a race condition where the member config has been updated since we created the list of
        // addresses to add (addrsToAdd) ... so do another loop to make sure we're not adding duplicates
        var exists = false;
        for (var _c = 0, _d = rsConfig.members; _c < _d.length; _c++) {
            var member = _d[_c];
            if (member.host === addr) {
                console.info('Host [%s] already exists in the Replicaset. Not adding...', addr);
                exists = true;
                break;
            }
        }
        if (exists)
            continue;
        var cfg = {
            _id: ++max,
            host: addr,
        };
        rsConfig.members.push(cfg);
    }
};
var removeDeadMembers = function (rsConfig, addrsToRemove) {
    if (!addrsToRemove || !addrsToRemove.length)
        return;
    for (var _i = 0, addrsToRemove_1 = addrsToRemove; _i < addrsToRemove_1.length; _i++) {
        var addr = addrsToRemove_1[_i];
        for (var i in rsConfig.members) {
            if (rsConfig.members[i].host === addr) {
                rsConfig.members.splice(i, 1);
                break;
            }
        }
    }
};
var isInReplSet = function (ip) { return __awaiter(_this, void 0, void 0, function () {
    var client, err_7, err_8;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, getClient(ip)];
            case 1:
                client = _a.sent();
                return [3 /*break*/, 3];
            case 2:
                err_7 = _a.sent();
                return [2 /*return*/, Promise.reject(err_7)];
            case 3:
                _a.trys.push([3, 5, 6, 7]);
                return [4 /*yield*/, replSetGetConfig(client.db(config.mongoDatabase))];
            case 4:
                _a.sent();
                return [2 /*return*/, true];
            case 5:
                err_8 = _a.sent();
                return [2 /*return*/, false];
            case 6:
                client.close();
                return [7 /*endfinally*/];
            case 7: return [2 /*return*/];
        }
    });
}); };
module.exports = {
    getClient: getClient,
    replSetGetStatus: replSetGetStatus,
    initReplSet: initReplSet,
    addNewReplSetMembers: addNewReplSetMembers,
    isInReplSet: isInReplSet,
};
