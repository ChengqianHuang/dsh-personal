# dsh-personal 设计决策

个人助理 bundle：SQLite 是 source of truth，LLM 只负责理解/分类/抽取/总结，永远不碰 SQL。

## 经历模型（experiences）

"看了一部/读了一本/听了一张/看了一场" 统一为 `experiences` 表：`category`（对象类别，开放词表）× `action`（动作，开放词表）× `title`（对象名）× `occurred_on`（发生日期）。新增一种经历类别不需要改代码、加表或迁移——只要说出对应的 category/action。

归一化规则（有测试锁定）：

- 写入：`trim + lowercase + 空白折叠`，存储为规范词元（`Movie` → `movie`）。
- 查询：使用相同的归一化规则，按存储的类别和动作键精确匹配。开放词表无法可靠地猜测单复数；模型应复用记录结果里的键。
- `query_experiences` 可在类别、动作、日期和标签之外，用 `text` 做分词关键词检索；有 `text` 时按相关性排序，否则按日期排列。查询结果展示类别、日期和备注。
- `occurred_on` 拒绝未来日期：未来要做的事是 task（`create_task`），不是经历。
- 评分 0–10 有限小数，端到端 REAL 存储。

schema 版本 4，类别、动作和标题在服务与 SQLite 中都必须非空。旧 v1–v3 数据库在打开时明确拒绝并给出重建指引；旧数据不迁移。

## 架构

```
dsh (未修改)
  └── dsh-personal bundle
        ├── PersonalService (ctx.personal)   确定性业务操作，唯一 SQL 持有者
        ├── store/    9 张 STRICT 表 + schema 版本 4 + 事务
        │     └── search.ts  连接内存 FTS5 索引 + Jieba 分词 + BM25 排序
        ├── dates.ts  时区感知日历（ISO 校验 / 周·月窗 / due_in 分桶 / 周末=周六截止）
        ├── review.ts 确定性事实组装（daily / weekly）
        └── tools/    19 个薄适配器（11 capture + 6 query + 2 review）
```

## 关键决策

1. **SQLite 自持文件**（`~/.dsh/personal/personal.db`），不落 dsh session log，不写 dsh 内部结构；行数据是纯个人领域数据，可独立读取。
2. **服务操作 = 一次 `await ready()` + 纯同步 store 工作**，项目创建和项目日志写入包进 `BEGIN IMMEDIATE` 事务；进程内不交错、跨进程由写锁串行化。
3. **链接只存一份**：task→project/website 在 tasks 外键列；blog/idea→project 在各自列；relations 表只存显式 `linkObjects`。
4. **打开失败不缓存**：`ready()` 失败清除共享 attempt，下次调用重试。
5. **查询上限截断**（>200 取前 200），与全部查询工具一致。
6. **日期规则集中在 dates.ts**：`dueDateOn(dueIn, today)` 纯函数；`this-weekend` 截止周六，遇周末日回退今天（永不落在过去）。
7. **评分端到端 REAL**，0–10 有限小数，记录和查询时不舍入。
8. **capture 契约在工具描述里**：研究兴趣（无行动承诺）→ idea；有行动/期限 → task；只有明确"记日记"才建 daily log；批量记录不附带日记。
9. **record_project_log 的 `projectCreated` 由写入事务确定**，并发调用不会把已有项目误报为新建。
10. **检索索引可重建**：FTS5 TEMP 表不写入个人数据库；TEMP trigger 与本连接写入一同提交或回滚。`data_version` 检测外部提交，搜索在主库读取快照内同步索引并取结果。设计取舍见 [Agent Note](.agents/notes/implemented/architecture/2026-09-28-derived-search-index.md)。
11. **跨类型统一排序**：`search_personal_data` 返回 `terms` 和全局 `hits`，BM25 权重由配置解析；默认标题 5、标签 3、正文 1，`limit` 是所有类型的总上限。`all` 要求全部分词，`any` 明确扩大到部分命中，不能把分组结果当作全局排序。

## 已知限制

- 相对过去日期（"昨天"）依赖模型知道当天日期（未来截止已用 due_in 枚举规避）；需要精确可挂载 time-context 类插件或直接说日期。
- 单写者形态：多实例共库靠 busy_timeout 兜底。
- 搜索是词法检索，不自动理解同义词；模型应提取主题词，把时间和类型放进过滤字段。索引首次构建和外部提交后的重建需扫描记录，适合当前个人数据规模。
- 无自动定时回顾（dsh-schedule 是会话内提醒而非 cron）。
