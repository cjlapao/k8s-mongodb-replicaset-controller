"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var worker_1 = require("./lib/worker");
console.log('testing');
var worker = new worker_1.Worker();
worker.init();
