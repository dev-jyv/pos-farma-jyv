const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  app: {
    /**
     * La ventana pidió cerrarse. El renderer decide: `confirmClose()` para salir
     * o `cancelClose()` para quedarse. Si nadie contesta, el proceso principal
     * cierra igual a los 10 s.
     */
    onCloseRequested: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:close-requested', listener);
      return () => ipcRenderer.removeListener('app:close-requested', listener);
    },
    /** "Ya te oí, estoy preguntando": frena el cierre de emergencia por timeout. */
    closePending: () => ipcRenderer.invoke('app:close-pending'),
    confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
    cancelClose: () => ipcRenderer.invoke('app:cancel-close'),
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  openCashDrawer: (printerName) => ipcRenderer.invoke('open-cash-drawer', printerName),

  catalog: {
    search: (term) => ipcRenderer.invoke('catalog:search', term),
    getByBarcode: (code) => ipcRenderer.invoke('catalog:getByBarcode', code),
    getBatchesByProduct: (productId) => ipcRenderer.invoke('catalog:getBatchesByProduct', productId),
    recordStockEntry: (payload) => ipcRenderer.invoke('catalog:recordStockEntry', payload),
    upsertMany: (products) => ipcRenderer.invoke('catalog:upsertMany', products),
    getPendingStockEntries: () => ipcRenderer.invoke('catalog:getPendingStockEntries'),
    markStockEntrySynced: (batchLocalId, remoteProductId) =>
      ipcRenderer.invoke('catalog:markStockEntrySynced', batchLocalId, remoteProductId),
    markStockEntryPushFailed: (batchLocalId, message) =>
      ipcRenderer.invoke('catalog:markStockEntryPushFailed', batchLocalId, message),
    getProductById: (id) => ipcRenderer.invoke('catalog:getProductById', id),
    createCatalogProduct: (fields) => ipcRenderer.invoke('catalog:createCatalogProduct', fields),
    updateCatalogProduct: (id, fields) => ipcRenderer.invoke('catalog:updateCatalogProduct', id, fields),
    getPendingCatalogPush: () => ipcRenderer.invoke('catalog:getPendingCatalogPush'),
    markCatalogSynced: (localId, remoteId) =>
      ipcRenderer.invoke('catalog:markCatalogSynced', localId, remoteId),
    markCatalogPushFailed: (localId, message) =>
      ipcRenderer.invoke('catalog:markCatalogPushFailed', localId, message),
    clearCatalogPushError: (localId) => ipcRenderer.invoke('catalog:clearCatalogPushError', localId),
  },

  sales: {
    createLocal: (sale) => ipcRenderer.invoke('sales:createLocal', sale),
    list: (filters) => ipcRenderer.invoke('sales:list', filters),
    getPendingPush: (filters) => ipcRenderer.invoke('sales:getPendingPush', filters),
    listBlocked: () => ipcRenderer.invoke('sales:listBlocked'),
    getPendingVoided: () => ipcRenderer.invoke('sales:getPendingVoided'),
    markSynced: (localId, remoteId, remoteFolio) =>
      ipcRenderer.invoke('sales:markSynced', localId, remoteId, remoteFolio),
    markUnreconciled: (localId, reason) =>
      ipcRenderer.invoke('sales:markUnreconciled', localId, reason),
    markPushFailed: (localId, message) => ipcRenderer.invoke('sales:markPushFailed', localId, message),
    voidLocal: (localId, voidedBy, voidedByLabel, reason) =>
      ipcRenderer.invoke('sales:voidLocal', localId, voidedBy, voidedByLabel, reason),
    listMovements: (saleId) => ipcRenderer.invoke('sales:listMovements', saleId),
    clearPushError: (localId) => ipcRenderer.invoke('sales:clearPushError', localId),
    discard: (localId) => ipcRenderer.invoke('sales:discard', localId),
    getNeedingRemoteVoid: () => ipcRenderer.invoke('sales:getNeedingRemoteVoid'),
    markNeedsRemoteVoid: (localId) => ipcRenderer.invoke('sales:markNeedsRemoteVoid', localId),
    markRemoteVoided: (localId) => ipcRenderer.invoke('sales:markRemoteVoided', localId),
  },

  sync: {
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    recordRun: (run) => ipcRenderer.invoke('sync:recordRun', run),
  },

  cashSessions: {
    getOpenLocal: (userId) => ipcRenderer.invoke('cashSessions:getOpenLocal', userId),
    /** Turno abierto en el equipo, de quien sea: para el efectivo del cajón físico. */
    getOpenLocalAnyUser: () => ipcRenderer.invoke('cashSessions:getOpenLocalAnyUser'),
    listBlocked: () => ipcRenderer.invoke('cashSessions:listBlocked'),
    createLocal: (input) => ipcRenderer.invoke('cashSessions:createLocal', input),
    getLiveSummary: (sessionId) => ipcRenderer.invoke('cashSessions:getLiveSummary', sessionId),
    getCashOnHand: () => ipcRenderer.invoke('cashSessions:getCashOnHand'),
    closeLocal: (sessionId, input) => ipcRenderer.invoke('cashSessions:closeLocal', sessionId, input),
    getPendingPush: (filters) => ipcRenderer.invoke('cashSessions:getPendingPush', filters),
    getPendingClosePush: (filters) =>
      ipcRenderer.invoke('cashSessions:getPendingClosePush', filters),
    markCreateSynced: (localId, remoteId) =>
      ipcRenderer.invoke('cashSessions:markCreateSynced', localId, remoteId),
    markCloseSynced: (localId, values) =>
      ipcRenderer.invoke('cashSessions:markCloseSynced', localId, values),
    markPushFailed: (localId, message) =>
      ipcRenderer.invoke('cashSessions:markPushFailed', localId, message),
    markClosePushFailed: (localId, message) =>
      ipcRenderer.invoke('cashSessions:markClosePushFailed', localId, message),
    clearPushError: (localId) => ipcRenderer.invoke('cashSessions:clearPushError', localId),
    clearClosePushError: (localId) => ipcRenderer.invoke('cashSessions:clearClosePushError', localId),
    listLocal: (filters) => ipcRenderer.invoke('cashSessions:listLocal', filters),
    updateAdjustmentStatus: (localId, values) =>
      ipcRenderer.invoke('cashSessions:updateAdjustmentStatus', localId, values),
  },

  /** Catálogos solo-pull: la caja los lee, el admin web los administra. */
  pharmacyServices: {
    list: (term) => ipcRenderer.invoke('pharmacyServices:list', term),
    listProviders: () => ipcRenderer.invoke('pharmacyServices:listProviders'),
    upsertMany: (services) => ipcRenderer.invoke('pharmacyServices:upsertMany', services),
    upsertProviders: (providers) => ipcRenderer.invoke('pharmacyServices:upsertProviders', providers),
  },
  cashMovements: {
    add: (cashSessionId, input) => ipcRenderer.invoke('cashMovements:add', cashSessionId, input),
    updateExpense: (id, patch) => ipcRenderer.invoke('cashMovements:updateExpense', id, patch),
    listForSession: (cashSessionId) => ipcRenderer.invoke('cashMovements:listForSession', cashSessionId),
    listAllLocal: (filters) => ipcRenderer.invoke('cashMovements:listAllLocal', filters),
    countAllLocal: (filters) => ipcRenderer.invoke('cashMovements:countAllLocal', filters),
    getPendingPush: (filters) => ipcRenderer.invoke('cashMovements:getPendingPush', filters),
    assertPushable: (id) => ipcRenderer.invoke('cashMovements:assertPushable', id),
    listBlocked: () => ipcRenderer.invoke('cashMovements:listBlocked'),
    discard: (id) => ipcRenderer.invoke('cashMovements:discard', id),
    markSynced: (localId, remoteId) => ipcRenderer.invoke('cashMovements:markSynced', localId, remoteId),
    markPushFailed: (localId, message) =>
      ipcRenderer.invoke('cashMovements:markPushFailed', localId, message),
    clearPushError: (localId) => ipcRenderer.invoke('cashMovements:clearPushError', localId),
  },
});
