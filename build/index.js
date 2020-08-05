"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_1 = require("./lib/worker");
console.log('testing');
const worker = new worker_1.Worker();
// setting the sigterm detection
process.on('SIGTERM', function onSigterm() {
    console.info('Got SIGTERM. Graceful shutdown start', new Date().toISOString());
    worker.shutdown();
});
worker
    .init()
    .then(() => {
    worker.doWork();
})
    .catch((error) => console.error('Error trying to initialize k8s-mongodb-controller', error));
//# sourceMappingURL=index.js.map