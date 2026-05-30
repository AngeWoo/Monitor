# 用 clasp 管理 / 拆分 GAS 後端

目前後端是單一 `程式碼.gs`（約 4500 行），靠複製貼上維護。改用 [clasp](https://github.com/google/clasp)
可以在本機用多檔管理、版本控管、一鍵 `clasp push` 部署。

> ⚠️ GAS 把專案內所有 `.gs` 檔視為**同一個全域命名空間**，拆檔純為整理，不改變執行邏輯。
> 但**頂層常數的載入順序**會影響有互相參照的常數（例如 `TEST_DELETE_DEFAULT_SHEET = SHEET_CHECKS`）。
> 因此拆檔時務必把**所有頂層常數集中在第一個檔**（檔名數字前綴最小），確保最先載入。

## 一、初始化 clasp

```bash
npm i -D @google/clasp        # 安裝（已在 package.json scripts 預留指令）
npm run gas:login             # = clasp login，用你的 Google 帳號授權
```

在專案根目錄建立 `.clasp.json`（不要進版控，含 scriptId）：

```json
{
  "scriptId": "<你的 Apps Script 專案 ID>",
  "rootDir": "gas"
}
```

> scriptId 在 Apps Script 編輯器 → 專案設定 → 「指令碼 ID」。

把現有後端先拉下來核對：

```bash
npm run gas:pull              # = clasp pull，會把線上版抓到 gas/
```

## 二、建議的拆分對應（放在 `gas/`，數字前綴決定載入順序）

| 檔案 | 內容（現有函式）|
|---|---|
| `00_constants.gs` | **所有頂層 const/var**：SHEET_*、*_HEADERS、PROP_*、CACHE_KEY_*/TTL、retention 常數等 |
| `10_web_api.gs` | `doGet`、`doPost`、`output_`、`jsonOut_`、`authOk_`、路由 switch |
| `20_services.gs` | `addService_`/`updateService_`/`deleteService_`/`hardDeleteService_`/`listServices_`/`buildServiceViews_`/`build*ServiceView_` |
| `30_checks.gs` | `runScheduler`/`runServiceChecks_`/`checkUrl_`/`fetchWithRedirectTrace_`/`runSingleCheckAttempt_`/`appendCheckLog_`/`appendProbeCheck_`/`getMetrics_`/`metricsAll_` |
| `40_probes.gs` | `listProbes_`/`upsertProbe_`/`updateProbeRow_`/`markProbeOffline_`/`clearProbeState_`/probe-run 訊號/`getProbeRelease_`/`updateProbeRelease_` |
| `50_portscan.gs` | port scan 設定/訊號/`updatePortScan_`/`listPortScans_` 及相關 parse 函式 |
| `60_securityscan.gs` | security scan 設定/訊號/`updateSecurityScan_`/`listSecurityScans_`/clamp/sanitize |
| `70_report_notify.gs` | report 設定、`sendStatusReport*`、LINE/Teams/Mail、`lineWebhook_`、notify log |
| `80_maintenance.gs` | retention（`maybeRunRetention_`/`trimSheetToMaxDataRows_`）、cache invalidate、日期範圍 |
| `90_util.gs` | `toNum_`/`toBool_`/`indexMap_`/`rowFromObj_`/`objFromRow_`/`escapeHtml_`/雜項 |
| `appsscript.json` | 專案 manifest（時區、runtime V8、進階服務）— 由 `clasp pull` 取得，勿手寫覆蓋 |

## 三、拆分後驗證（重要）

拆完後務必確認「所有檔案串接 = 原始檔內容」（無遺漏、無重複），再 push：

```bash
# 串接所有 gas/*.gs，與原始 程式碼.gs 比對函式清單是否一致
npm run gas:push             # = clasp push；先用 clasp push --watch 在測試專案試
```

建議流程：先 `clasp clone` 一個**測試用** Apps Script 專案 push 驗證 doGet/doPost 正常，
再切回正式 scriptId。確認 `?action=listServices`、`getSecurityScanSignal` 等端點都正常回應後才算完成。
