# 实盘资金风险审查报告

**项目**：`polymarket-btc5m-strategy`（BTC 5m Up/Down 双边策略）  
**审查范围**：实盘路径 `bot.js` → `lib/executor.js` → `lib/live_clob.js` → `lib/settle.js` → `lib/ledger.js`  
**审查目标**：找出可能导致真实资金损失的缺陷  
**日期**：2026-08-17

---

## 1. 结论摘要

规则层（`signal.js`）与执行层（二次验价、CLOB 余额检查、配对风控）在**理想路径**上设计合理，但存在若干缺口。实盘上「一腿成交、一腿失败」时，策略会从低风险套利变成方向性敞口。

**上线前必须处理 P0 三项：**

1. 每次扫描都检查并处理单边敞口
2. 平仓失败不得标记为风控成功，必须持续重试
3. HTTP API 加鉴权，或仅绑定本机

---

## 2. 风险分级说明

| 级别 | 含义 |
|------|------|
| **Critical** | 可直接导致真实资金损失或单边全损 |
| **High** | 高概率造成亏损、账实不符或错误结算 |
| **Medium** | 放大风险、误导运维或 paper/live 行为不一致 |
| **Low** | 运维/配置类，间接增加损失概率 |

---

## 3. Critical（严重）

### 3.1 配对风控只在下单时触发，常规扫描不检查

**位置**：`lib/executor.js`（`executePlan`）、`bot.js`（`runScan`）

`enforcePairHedge()` 仅在 `executePlan()` 且 `mode === 'pair'` 时调用。`runScan()` 每约 2 秒只做 `matchLiveOpenOrders()`，**从不**调用 `enforcePairHedge()`。

**风险场景**：

- Up 的 GTC 已成交，Down 未成交 / 被取消 / 下单失败
- 下一次 `BUY` 信号到来前可能长达数分钟
- 期间持有单边 Up 或 Down，变成方向性赌注

**资金影响**：BTC 5m 结算若站错边，该腿可接近 **100% 亏损**。这是双边套利策略中最大的结构性风险。

**建议修复**：每次 live `runScan()` 对开放持仓/挂单做失衡检测与 `enforcePairHedge`（或等价 unwind 循环）。

---

### 3.2 平仓失败仍报告「风控成功」，且无重试

**位置**：`lib/live_clob.js` → `enforcePairHedge`、`tryUnwindLeg`

缺一侧时会撤单并尝试 FOK 卖出，但：

- `tryUnwindLeg()` 失败（无 bid、FOK 被拒、网络错误）仍返回 `hedged: true`
- 日志写「已撤/平」，仓位可能仍在
- 后续 scan **不会自动重试 unwind**
- FOK 只卖 `min(持仓, bid深度)`，大额可能只平一部分

**资金影响**：误以为已对冲，实际单边敞口持有至结算。

**建议修复**：unwind 失败返回 `hedged: false`；对未平尽仓位持续重试并告警；部分成交后继续处理剩余份额。

---

### 3.3 对账可能「丢成交」并错误释放 reserve

**位置**：`lib/live_clob.js` → `reconcileLiveOpenOrders`

本地 open、交易所已不在 open orders 时：先 `matchOneLiveOrder`，失败被吞掉后，仍把订单标为 `cancelled` 并 `releaseReserve`。

若订单其实已全部成交：

- 本地 `filled` 仍为 0
- `applyBuy()` 从未记账
- 账本无持仓，交易所/链上仍有 token

**资金影响**：结算模块不处理这些 token；可能错过 redeem，资金锁死或漏结算。

**建议修复**：`matchOneLiveOrder` 失败时**不要**释放 reserve、不要标 cancelled；改为告警并重试，直到确认成交或确认取消。

---

### 3.4 HTTP API 无鉴权，绑定 `0.0.0.0`

**位置**：`bot.js`（`server.listen(PORT, '0.0.0.0')`）

未鉴权接口包括：

| 接口 | 风险 |
|------|------|
| `POST /api/params` | 改策略参数 |
| `POST /api/pause` | 暂停/恢复 |
| `POST /api/scan` | 触发扫描下单 |
| `POST /api/settle-check` | 强制结算 |

**资金影响**：端口暴露时，他人可改参数或触发下单，造成直接损失。

**建议修复**：绑定 `127.0.0.1`，或加 token / IP 白名单。

---

## 4. High（高）

### 4.1 双腿下单非原子

**位置**：`lib/live_clob.js` → `syncLiveQuotes`

Up / Down 顺序 `placeLiveBuy()`，不是原子 batch。第一腿已上交易所、第二腿失败之间存在单边时间窗（依赖问题 3.1 / 3.2 收口）。

**建议修复**：尽量同时发单或缩短间隔；第二腿失败立即 unwind 第一腿。

---

### 4.2 Maker 用 bidSum 门槛，成交可能变成 Taker

**位置**：`lib/signal.js`、`lib/live_clob.js` → `bookLiveFill`

入场用 `bidSum ≤ 0.99`。挂单被穿过后可能按 **ask（taker）** 成交：

- 手续费更高（默认 `taker_fee_rate: 0.07`）
- `askSum` 可能 > 1
- 成交后**不再**校验 pairSum

**资金影响**：名义套利，实际 taker 成交后边际变负。

**建议修复**：taker 成交后复查 `fillSum + fee ≤ pair_sum_max`（或更严缓冲）；超限则 unwind。

---

### 4.3 账本 `cash_usdc` 与交易所余额长期偏离

**位置**：`lib/ledger.js` → `applyBuy`；`lib/redeem.js`

Live 成交时账本现金不足会静默 `topUp`。结算先把 proceeds 记入账本，链上 redeem 失败只打 warning。新开仓虽用 `fetchAccountCashUsdc()` gate，但 `trackLiveOrder()` 仍用账本现金做 reserve。

**资金影响**：账实不符，难以判断真实可用资金，reserve 可能错误。

**建议修复**：live 以交易所余额为准；redeem 失败进入强制重试队列，账本 proceeds 与链上赎回状态分离。

---

### 4.4 结算价依赖模糊标题匹配

**位置**：`lib/settle.js` → `fetchGammaResolvedSettlePrice`

用 Gamma `public-search` + `title` 匹配市场。相似标题可能匹配到错误市场。

**资金影响**：账本 PnL 错误；错判 0/1 可能提前错误清仓。

**建议修复**：用 `conditionId` 精确查询，禁止仅靠 title。

---

## 5. Medium（中）

### 5.1 `state.json` 无并发锁

`runScan()` 与 `/api/params`、`/api/pause` 等各自 `loadState()` / `saveState()`。并发写入可能丢失挂单/持仓更新，风控基于过期状态。

**建议修复**：单写者队列或文件锁。

---

### 5.2 Paper 模式无配对风控

`enforcePairHedge` 只在 `isLive()` 分支。Paper 可积累失衡仓位，用 paper 参数上 live 会低估配对失败风险。

**建议修复**：paper 同步实现 hedge 逻辑，便于验证。

---

### 5.3 `tryUnwindLeg` 卖出未扣 taker 费

`proceeds = matched * px`，未扣 Polymarket taker fee。账本偏乐观。

**建议修复**：卖出按 `withTakerFeeCash('SELL', ...)` 或 API 实际金额入账。

---

### 5.4 孤儿订单接管破坏配对假设

对账接管的未知挂单 `paired: false`，不参与配对逻辑，可能加剧单边敞口。

**建议修复**：按 token 映射市场后纳入 hedge；无法识别则立即撤单。

---

## 6. Low / 运维

| 问题 | 说明 |
|------|------|
| 赎回失败仅每轮最多 5 笔 | `retryPendingRedeems(state, limit=5)`，积压时资金滞留 |
| `LOCK_MODE=false` 时靠 `mode.json` | 误配可能意外进 live |
| 同一私钥跑 paper + live | 两实例抢同一 CLOB 余额 |

---

## 7. 风险链路

```
Up 成交 / Down 未成交
        │
        ├─ 常规 scan 不跑 enforcePairHedge ──► 单边持有至结算 ──► 错边接近全损
        │
        └─ tryUnwindLeg 失败仍返回 hedged:true ──► 不再重试 ──► 同上

reconcile 时 match 失败
        │
        └─ 标 cancelled + 释放 reserve ──► 账本无仓 / 交易所有 token
                                              ──► 无法自动结算 / redeem
```

---

## 8. 修复优先级

| 优先级 | 修复项 | 对应缺陷 |
|--------|--------|----------|
| **P0** | 每次 live `runScan()` 做失衡检测与 hedge | §3.1 |
| **P0** | unwind 失败视为未完成，持续重试 + 告警 | §3.2 |
| **P0** | API 鉴权，或只 bind `127.0.0.1` | §3.4 |
| **P1** | reconcile：match 失败禁止 release / cancelled | §3.3 |
| **P1** | taker 成交后复查 fillSum + 费用 | §4.2 |
| **P1** | 双腿尽量同时发单，缩短时间窗 | §4.1 |
| **P2** | 结算用 `conditionId`，不用 title 搜索 | §4.4 |
| **P2** | `state.json` 加锁或单写者 | §5.1 |
| **P2** | paper 同步配对风控；卖出扣费；孤儿单处理 | §5.2–§5.4 |

---

## 9. 实盘上线检查清单

- [x] 扫描循环内持续检查 Up/Down 失衡并 unwind（`checkAllPairExposures` / `checkAllPaperPairExposures`）
- [x] unwind / 撤单失败可观测、可重试，不假装成功（`tryUnwindLegAll` + `unwindFailed`）
- [x] 对账失败不丢成交、不误释资金（`reconcileLiveOpenOrders` 保留 pending）
- [x] 面板默认绑定 `127.0.0.1`；POST 需 `BOT_API_TOKEN`（可选 `BIND_HOST=0.0.0.0` 暴露）
- [x] Live 以交易所余额与持仓为准，账本每轮 `syncLiveLedgerFromClob` 镜像 CLOB 可用余额
- [x] 结算与赎回按 `conditionId` 优先查询（`fetchGammaByConditionId`）
- [x] 赎回失败重试上限提高（`REDEEM_RETRY_LIMIT`，默认 50）
- [ ] Paper 与 Live 使用独立密钥/资金（运维配置，非代码）

---

## 11. 修复记录（2026-08-17）

| 缺陷 | 修复 |
|------|------|
| §3.1 扫描不检查配对 | `bot.js` 每轮调用 `checkAllPairExposures` / `checkAllPaperPairExposures` |
| §3.2 unwind 假成功 | `tryUnwindLegAll` 多轮平仓；失败返回 `unwindFailed: true` |
| §3.3 对账丢成交 | match 失败不 release；未入账成交保留 open |
| §3.4 API 无鉴权 | 默认 `127.0.0.1` + `BOT_API_TOKEN` 保护 POST |
| §4.1 非原子下单 | `syncLiveQuotes` 并行 `Promise.all` 发单 |
| §4.2 taker 成本 | `validatePairedPositionCost` 检查 pairCost |
| §4.4 结算 title 匹配 | 优先 `fetchGammaByConditionId` |
| §5.1 并发写 state | `lib/state_lock.js` + `withStateLock` |
| §5.2 paper 无 hedge | `auditPaperPairExposure` |
| §5.3 卖出未扣费 | `withTakerFeeCash('SELL', ...)` |
| §4.3 账本偏离 | `syncLiveLedgerFromClob` 每轮同步；`trackLiveOrder` 可回退 `clob_cash_usdc` |
| §5.2 paper legacy | instant fill 路径也跑 `auditPaperPairExposure` |
| 测试 | `npm test` → `test/risk-guards.test.js` |
| Dashboard | `/api/status` 返回 `risk` 字段；面板显示风控状态 |
| 配置模板 | `.env.example` |

---

## 10. 相关代码位置速查

| 模块 | 文件 | 关键函数 |
|------|------|----------|
| 扫描主循环 | `bot.js` | `runScan()` |
| 执行计划 | `lib/executor.js` | `executePlan()` |
| 配对风控 | `lib/live_clob.js` | `enforcePairHedge()`、`tryUnwindLeg()` |
| 实盘下单 | `lib/live_clob.js` | `syncLiveQuotes()`、`reconcileLiveOpenOrders()` |
| 信号判断 | `lib/signal.js` | `evaluateMarket()` |
| 结算 | `lib/settle.js` | `settleEndedPositions()`、`fetchGammaResolvedSettlePrice()` |
| 账本 | `lib/ledger.js` | `applyBuy()` |
| 赎回 | `lib/redeem.js` | `redeemSettledPosition()` |
