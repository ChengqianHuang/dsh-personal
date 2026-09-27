# dsh-personal

https://github.com/ChengqianHuang/dsh-personal · topic: `dsh-plugin`

个人助理 bundle：让 dsh 用自然语言记录/查询/回顾你的个人数据（**经历**——电影/书/专辑/展览等任意类别、项目日志、任务、博客、网站、想法、每日记录），全部落在一个 SQLite 文件（`~/.dsh/personal/personal.db`）里。LLM 只负责理解和总结，事实全部来自 SQLite，重启后依旧可查。

安装与使用见 dsh 用户文档 `docs/user/develop/basic/publish.md`。设计决策见 [DESIGN.md](DESIGN.md)。

## 安装（dsh 源码运行模式下）

本仓库 clone（或 link）到任意位置后，在 dsh 仓库根目录安装进 profile：

```sh
# 从本仓库的本地 clone 安装（link 模式，源码即生效）
pnpm dsh plugin --profile web add /path/to/dsh-personal
pnpm dsh --profile web --dump-config               # 验证出现 "# == dsh-personal" 层
pnpm dsh web                                       # 启动后直接对话
```

卸载：`pnpm dsh plugin --profile web remove dsh-personal`。

配置（可选，写进 profile 的 cordis.patch.yml 或由 bundle 默认值兜底）：

```yaml
- id: personal
  name: dsh-personal
  config:
    timezone: Asia/Shanghai     # 日期分桶时区，默认进程时区
    # databasePath: ~/.dsh/personal/personal.db
    # enableDailyReview: true
    # enableWeeklyReview: true
```

## 构建 / 测试

```sh
cd dsh-personal && npx tsdown        # 产出 lib/index.mjs（bundle 入口）
npx vitest run --config dsh-personal/vitest.config.ts   # 64 项测试（在 dsh 仓库根运行）
```

修改源码后重新 `npx tsdown` 即可（profile 里是 link，指向本目录）。

## 工具（19 个）

- 记录：`record_experience`（任意经历类别：movie/book/album/exhibition/…，新增类别无需改代码）`create_project` `record_project_log` `create_task` `update_task` `complete_task` `create_blog_post` `update_blog_post` `create_idea` `record_daily_log` `register_website`
- 查询：`query_experiences` `query_tasks` `query_project_logs` `query_blog_posts` `query_websites` `search_personal_data`
- 回顾：`generate_daily_review` `generate_weekly_review`

用法示例：直接说「今天看了《灵媒》，7.5 分」「读了半本《失控》」「Forge 今天定位了中文错位问题」「周末检查博客证书」「我有哪些事情没做？」「本周回顾」。
