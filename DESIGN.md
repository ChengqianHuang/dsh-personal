# dsh-personal 设计决策

个人助理 bundle：SQLite 是 source of truth，LLM 只负责理解/分类/抽取/总结，永远不碰 SQL。

## 经历模型（experiences）

"看了一部/读了一本/听了一张/看了一场" 统一为 `experiences` 表：`category`（对象类别，开放词表）× `action`（动作，开放词表）× `title`（对象名）× `occurred_on`（发生日期）。新增一种经历类别不需要改代码、加表或迁移——只要说出对应的 category/action。

归一化规则（有测试锁定）：

- 写入：`trim + lowercase + 空白折叠`，存储为规范词元（`Movie` → `movie`）。
- 查询：同样归一后做受控单复数展开（`movies` → `{movies, movie}`；`series` → `{series, serie}`，多余变体不命中）。
- `occurred_on` 拒绝未来日期：未来要做的事是 task（`create_task`），不是经历。
- 评分 0–10 有限小数，端到端 REAL 存储。

schema 版本 3。旧 v1/v2 数据库（movie 中心模型）在打开时明确拒绝并给出重建指引——刻意不写 movies→experiences 的数据迁移。

## 架构

```
dsh (未修改)
  └── dsh-personal bundle
        ├── PersonalService (ctx.personal)   确定性业务操作，唯一 SQL 持有者
        ├── store/    9 张 STRICT 表 + migration 2 + 事务
        ├── dates.ts  时区感知日历（ISO 校验 / 周·月窗 / due_in 分桶 / 周末=周六截止）
        ├── review.ts 确定性事实组装（daily / weekly）
        └── tools/    19 个薄适配器（11 capture + 6 query + 2 review）
```

## 关键决策

1. **SQLite 自持文件**（`~/.dsh/personal/personal.db`），不落 dsh session log，不写 dsh 内部结构；行数据是纯个人领域数据，可独立读取。
2. **服务操作 = 一次 `await ready()` + 纯同步 store 工作**，多语句写包进 `BEGIN IMMEDIATE` 事务（项目创建/项目日志/网站注册）；进程内不交错、跨进程由写锁串行化。
3. **链接只存一份**：task→project/website 在 tasks 外键列；blog/idea→project 在各自列；relations 表只存显式 `linkObjects`。
4. **打开失败不缓存**：`ready()` 失败清除共享 attempt，下次调用重试。
5. **查询上限截断**（>200 取前 200），与全部查询工具一致。
6. **日期规则集中在 dates.ts**：`dueDateOn(dueIn, today)` 纯函数；`this-weekend` 截止周六，遇周末日回退今天（永不落在过去）。
7. **评分端到端 REAL**（migration 2 重建 movies 表），0–10 有限小数。
8. **capture 契约在工具描述里**：研究兴趣（无行动承诺）→ idea；有行动/期限 → task；只有明确"记日记"才建 daily log；批量记录不附带日记。
9. **record_project_log 回显解析后的项目行**，模型可见实体归一结果。

## 已知限制

- 相对过去日期（"昨天"）依赖模型知道当天日期（未来截止已用 due_in 枚举规避）；需要精确可挂载 time-context 类插件或直接说日期。
- 单写者形态：多实例共库靠 busy_timeout 兜底。
- 搜索是子串匹配，无排序/分词。
- 无自动定时回顾（dsh-schedule 是会话内提醒而非 cron）。
