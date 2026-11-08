import assert from 'node:assert/strict';
import { memberLineMetrics } from '../js/line-metrics.js';

const full = {
  lineMetricsVersion: 2, lineMetricsFound: true,
  lineMetricsAvailable: {consumerTotalLines: true, realLines: true, ownSalesLines: true, regularDeliveryLines: true},
  consumerTotalLines: 5, realLines: 5, ownSalesLines: 0, regularDeliveryLines: 0,
};
assert.deepEqual(memberLineMetrics(full), {total:5, real:5, own:0, delivery:0, kt:null, lg:null, needsCollectorUpdate:false});
assert.equal(memberLineMetrics({...full, realLines:null, lineMetricsAvailable:{consumerTotalLines:true}}).real, null);
const legacy = memberLineMetrics({lineMetricsFound:true, consumerTotalLines:5, realLines:0, ownSalesLines:0, regularDeliveryLines:0});
assert.equal(legacy.total, 5);
assert.equal(legacy.real, null);
assert.equal(legacy.own, null);
assert.equal(legacy.needsCollectorUpdate, true);
assert.equal(memberLineMetrics({lineMetricsFound:true,realLines:3}).real, 3);
assert.equal(memberLineMetrics({lineMetricsFound:false, realLines:0}).real, null);
assert.equal(memberLineMetrics({}, {'총회선':0,'KT망':0,'LG망':0}).total, 0);
assert.equal(memberLineMetrics({}, {'총회선':5}).kt, null);
console.log('Line metric tests passed: actual zero, missing fields, legacy false zeros, network counts.');
