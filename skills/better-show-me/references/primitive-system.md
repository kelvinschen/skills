# ShowMe 原语系统

本文件负责原语选型与语义边界；[rendering-text.md](rendering-text.md) 和 [rendering-html.md](rendering-html.md) 只负责媒介投影。

先确定用户要建立的心理模型，再选一个主导原语。局部代码与状态快照只能作为证据附着其上。

## 共同约束

| 关注点 | 要求 |
| :--- | :--- |
| 基线 | 给出正常状态、旧行为、既有契约或可比方案 |
| 焦点 | 让最关键的入口、变化、矛盾或断点成为阅读重心 |
| 证据 | 为关键推断选择最小的决定性事实，并贴在推断发生处 |
| 裁剪 | 围绕当前判断选择分支，并交代视图覆盖范围 |

核心关系进入节点、边或分支；证据使用 `@ path:line` 沿对应事实下沉。解释性文字只有在改变理解或下一步时才保留。

## 通用原语

### 伪代码

用于解释单体逻辑。保留触发、守卫、不可逆副作用和成功/失败/跳过终态，省略语法与样板。重点变成“谁调用谁”时用调用树；出现等待或跨生命周期协作时用轻量时序。

```text
on publishDraft(draft)
  if draft is unchanged
    return currentVersion
  errors = validate(draft)
  if errors exist
    return validationErrors
  persist new version
  emit content.published
  return publishedVersion
```

### 调用树

从一个明确入口展开影响结果的父子调用，标出分支、状态读写、I/O 和返回值。源码锚点落在入口与决定路径的节点；内部条件复杂时附伪代码，跨进程或异步生命周期时局部升级为轻量时序。

```text
submitOrder() → Order
├── validateCart()
├── reserveInventory()
│   └── reservationRepository.save()
└── createOrder()
    └── orderRepository.insert()
```

### 组件树

保留相关组件层级、状态所有者、关键 prop ↓、event ↑ 和条件挂载，源码位置跟随状态所有者或当前焦点。组件树聚焦行为贡献；像素布局用 UI 视觉，跨生命周期协作用轻量时序。

```text
CheckoutPage — state: useCheckout()
  @ CheckoutPage.tsx:18
  ├── cart ↓ OrderSummary
  ├── PaymentForm submit(pay) ↑
  └── when paymentFailed
      └── PaymentError retry(pay) ↑
```

### 浅层文件树

只列与问题直接相关的路径、职责和公共入口，并用裁剪行说明省略范围及其为何不相关。需要看模块依赖时用架构图；只需证明一处实现时附局部代码。

```text
src/orders/
├── index.ts                    # 公共入口：导出 createOrder
├── service.ts                  # 编排校验、库存预留与持久化
├── repository.ts               # 订单存取边界
└── pricing/…                   # 已裁剪：本次不讨论计价算法
```

### 轻量时序

仅在网络、进程、队列、回调、超时、重试或并发竞争改变结果时使用，参与者数量不是启用依据。区分同步调用、返回、异步消息和等待终态；单线程内部调用改用调用树，数据结构演化改用数据形变链。

```text
1. Client → API        POST /exports
2. API → Queue         enqueue(exportId)
3. API → Client        202 Accepted
4. Queue → Worker      claim(exportId)
5. Worker → Storage    write report.csv
6. Worker → Client     export.completed

30s 未完成 → Client 显示“仍在处理”
```

### 语义 Diff

声明基线与目标，保留意图、可观察后果和至少一个不变量，删除格式化与机械噪声。Diff 必须保留宿主形态；比较多个候选方案时改用对齐对照。

```diff
 <CheckoutPage>
   <OrderSummary />
   <PaymentForm onSubmit={pay} />
+  {paymentFailed && <PaymentError retry={pay} />}
```

结果：支付失败后可以原位重试；状态仍归 `CheckoutPage`，`pay()` 的调用契约保持不变。

### 对齐对照

所有候选使用相同维度；每个维度来自项目事实并能改变判断，逐行给出差异含义，最后直接收束为选择条件。同一对象的前后变化用语义 Diff。

| 当前项目约束 | 轮询 | SSE | 判别 |
| :--- | :--- | :--- | :--- |
| 代理必须支持 HTTP/1.1 | 满足 | 满足 | 相同，不参与决策 |
| 10 秒内需看到进度 | 最坏延迟 5 秒 | 服务端即时推送 | SSE 更合适 |
| 客户端必须离线恢复 | 需保存 cursor | 原生支持 `Last-Event-ID` | SSE 更合适 |

结论：当前约束下选择 SSE；若代理会缓冲流式响应，则结论失效。

### 局部代码

当精确语法本身改变判断时，用一个锚点、一两行焦点代码和最小上下文完成证明；运行时结论再连接状态快照或日志。

`src/session/normalize.ts:41-45`，附着在“缺失 session 会回退为空对象”这一结论上：

```ts
const session = cache.get(id);
return session ?? createEmptySession(id); // 焦点：显式建立回退值
```

这证明静态回退路径存在，不证明生产请求实际走到了这里。

### 值 / 状态快照

围绕宿主节点聚焦相关字段、before → after 和证据来源；时间或运行标识用于区分实例。复杂字段转换用数据形变链，多个时间点的协作用轻量时序。

```text
step 4 · reserveInventory(order-1842)
  @ inventory-reservation.test.ts

available    3 → 1
reserved     0 → 2
order.status PENDING → RESERVED
requestId    req-72f
```

## 理解现状

### 数据形变链

按顺序连接原始输入、必要阶段、真实转换函数和最终形态，在字段原位标出新增、删除、改名与类型变化。多个角色交换数据时用时序或数据流图；没有结构变化时用调用树。

```text
HTTP OrderInput
  { sku: "A-17", quantity: "2" }
    → normalizeOrderInput()
Domain OrderRequest
  { sku: "A-17", quantity: 2 }
    → attachCatalogItem()
Priced Order
  { sku: "A-17", quantity: 2, unitPrice: 399 }
```

### 状态路径

保留初始状态、可达状态、真实事件、守卫、副作用和终止状态，只展开当前问题涉及的分支。单次线性调用用伪代码或调用树，多参与者协议用轻量时序。

```text
PENDING
  ├── payment.succeeded  → PAID      # capture inventory
  ├── payment.failed     → FAILED    # release reservation
  └── timeout && unpaid  → EXPIRED   # close order
```

## 理解变化

### 行为前后对照

以共同基线逐行对齐修改前后行为、契约变化和保持项，不复制两份完整实现。纯语法或局部结构变化用语义 Diff。

```text
行为                修改前                         修改后
────────────────────────────────────────────────────────────
保存失败            关闭编辑器并显示 toast          保留草稿并原位重试
再次提交            重新输入全部内容                复用本地草稿
API 契约           PUT /drafts/:id               PUT /drafts/:id
```

结果：失败恢复从“重新开始”变为“原位继续”；服务端接口保持不变。

### 影响半径

以改动为中心, 沿可证明的依赖路径展开直接和间接影响，给出风险强度与传播原因；以隔离证据标出保持稳定的区域。

```text
改动: verifyToken()
├── 高风险  直接影响   gateway/middleware.ts   入参签名不匹配
├── 注意    间接影响   routes/admin/*          旧 token 提前失效
└── 正常    保持稳定   routes/public/*         不经过鉴权链
```

## 定位问题

### 预期 / 实际分叉

先画共同路径，只在第一处分歧展开预期与实际，并把期望来源、局部状态、错误和源码证据贴在断点上。没有明确基线或分歧时用故障因果链或调用树。

```text
validateCoupon(input)
  │
  ├── 预期  coupon == null → useBasePrice() → 200
  │   @ pricing.md:18
  └── 实际  coupon == null → coupon.rule
      ✕ TypeError
      @ promo-service.ts:42
```

### 故障因果链

沿单一方向区分诱因、首个错误状态、传播条件和最终症状，把修复锚点放在真正能截断传播的位置。时间先后不等于因果；多线程交错先用轻量时序还原事实。

```text
部署遗漏 SESSION_SECRET
  → session middleware 为当前实例生成临时密钥
      └─ 修复：启动时缺少密钥即失败
         @ config/session.ts:18
  → 请求切换实例时，旧 cookie 无法通过验证
  → 用户随机退出登录
```

## 做出决策

### 权衡矩阵

用于多个可行方案之间的选择。比较会改变当前决策的现实约束，为每项给出项目证据、判优和不可兼得，最后声明推荐及失效条件。

| 当前约束 | 进程内队列 | 持久化队列 | 判优 |
| :--- | :--- | :--- | :--- |
| 进程重启后任务不能丢 | 无法满足 | 可恢复未完成任务 | 持久化队列 |
| 峰值每分钟 20 个任务 | 足够 | 足够 | 不参与决策 |
| 团队不维护额外服务 | 满足 | 增加运维成本 | 进程内队列 |

推荐：选择持久化队列，因为“任务不能丢”是硬约束；若任务允许重建，推荐失效。

不可兼得：不引入额外服务，就无法同时获得进程重启后的任务恢复。

### 方案骨架对照

用两个同高度的最小结构聚焦控制权、状态所有权、并发模型或接口契约的本质差异。共同维度更重要时用权衡矩阵；同一实现的变化用语义 Diff。

```text
方案 A：页面持有状态                 方案 B：流程模块持有状态

CheckoutPage owns state              CheckoutFlow owns state
├── useCheckout()                    ├── submitPayment()
├── PaymentForm                      └── CheckoutPage
└── submitPayment()                      └── PaymentForm

本质差异：B 将状态与提交流程从页面移入领域边界，页面只负责渲染。
```
