"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_1 = require("./lib/worker");
// Extensions
if (Array.prototype.min) {
    Array.prototype.max = function () {
        return Math.max.apply(null, this);
    };
    Array.prototype.min = function () {
        return Math.min.apply(null, this);
    };
}
Date.prototype.addHours = function (h) {
    console.log('getting new data');
    const hourToStamp = h * 60 * 60 * 1000;
    const newTime = this.setTime(this.getTime() + hourToStamp);
    return new Date(newTime);
};
// setting the sigterm detection
process.on('SIGTERM', function onSigterm() {
    console.info('Got SIGTERM. Graceful shutdown start', new Date().toISOString());
    worker.shutdown();
});
console.log('testing');
const worker = new worker_1.Worker();
worker
    .init()
    .then(() => {
    worker.doWork();
})
    .catch((error) => console.error('Error trying to initialize k8s-mongodb-controller', error));
//# sourceMappingURL=index.js.map