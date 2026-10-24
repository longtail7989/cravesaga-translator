/* Only chrome.runtime is used in the offscreen document. */
(() => {
  'use strict';
  const types = new Set(['NET_START','NET_POLL','NET_CANCEL','NET_CANCEL_ALL','NET_FORGET']);
  const waiting = new Map();
  let worker = null, sequence = 0;
  const unavailable = () => ({status:'error',error:{code:'CONTEXT_LOST',message:'Network worker is unavailable.'}});
  function failWorker() {
    if (worker) worker.terminate();
    worker = null;
    for (const item of waiting.values()) { clearTimeout(item.timer); item.reply(unavailable()); }
    waiting.clear();
  }
  function getWorker() {
    if (!worker) {
      worker = new Worker(chrome.runtime.getURL('network-worker.js'));
      worker.onmessage = event => {
        const item = waiting.get(event.data?.requestId);
        if (!item) return;
        waiting.delete(event.data.requestId);
        clearTimeout(item.timer);
        item.reply(event.data.result);
      };
      worker.onerror = failWorker;
      worker.onmessageerror = failWorker;
    }
    return worker;
  }
  chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
    if (message?.target !== 'network-offscreen') return false;
    // Content scripts share runtime.id but always have sender.tab.
    if (!sender || sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
    if (!types.has(message.type)) {
      sendResponse({status:'error',error:{code:'INVALID_REQUEST',message:'Invalid network request.'}});
      return false;
    }
    if (waiting.size >= 64) {
      sendResponse({status:'error',error:{code:'BUSY',message:'Network message capacity reached.'}});
      return false;
    }
    const requestId = String(++sequence);
    try {
      const instance = getWorker();
      const timer = setTimeout(() => {
        const item = waiting.get(requestId);
        if (item) { waiting.delete(requestId); item.reply(unavailable()); }
      },1500);
      waiting.set(requestId,{reply:sendResponse,timer});
      instance.postMessage({type:message.type,jobId:message.jobId,request:message.request,requestId});
      return true;
    } catch {
      const item = waiting.get(requestId);
      if (item) { clearTimeout(item.timer); waiting.delete(requestId); }
      sendResponse(unavailable());
      return false;
    }
  });
})();
