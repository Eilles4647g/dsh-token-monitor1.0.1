[README.md](https://github.com/user-attachments/files/34305264/README.md)
# dsh-token-monitor1.0.1
DSH Token Monitor  DeepSeek Harness（DSH）的本地 Token 与成本监控面板。安装后会在 DSH 左侧栏出现 **Token监控**，打开即可查看会话历史数据。
# DSH Token Monitor

DeepSeek Harness（DSH）的本地 Token 与成本监控面板。安装后会在 DSH 左侧栏出现 **Token监控**，打开即可查看会话历史数据。

## 面板会显示什么

- 模型调用次数，包含成功的助手调用与未成功的重试。
- 输入、输出、缓存读取和缓存写入 Token。
- 按模型统计调用和 Token。
- 每日 Token 消耗曲线，最多显示最近 180 天。
- 最近 20 条已记录调用。
- 可编辑每个模型的单价，并估算费用。

首次打开面板会读取 DSH 会话历史，历史较多时需要等待扫描结束。之后点击“刷新统计”同步新增调用。当前进行中的调用会在 DSH 写入结算事件后被统计。

成本按用户填写的 USD / 百万 Token 价格计算，不是服务账单。提供方未上报 Token 的调用会计入调用次数，但不会虚构 Token 或成本。

## 安装

请将本项目的文件和文件夹放在 GitHub 仓库的**根目录**，确认根目录直接包含 package.json、cordis.patch.yml、src/ 和 lib/client.js。

你的 DSH 版本需为 0.2.1-rc.5 或更新的 0.2.x 版本。使用 DSH Desktop 时，在 PowerShell 运行：

~~~powershell
dsh plugin --profile desktop add "github:Eilles4647g/dsh-token-monitor"
~~~

安装完成后重启 DSH Desktop。在左侧栏选择 **Token监控**。

如果 GitHub 用户名或仓库名不同，请按实际仓库地址修改命令。GitHub 仓库必须公开，或当前 Git 客户端必须有权读取它。

### PowerShell 显示 GitHub 安装错误时

如果出现 ERR_PNPM_GIT_RESOLVE_FAILED 或 git ls-remote failed，通常表示本机 Git 无法按 DSH/pnpm 使用的 HTTPS 地址访问 GitHub。先安装 Git for Windows 并确认新开的 PowerShell 能运行 git --version。若 Git 只能经 SSH 连接 GitHub，可在 PowerShell 按报错提示运行：

~~~powershell
git config --global url."git@github.com:".insteadOf "https://github.com/"
~~~

这个 GitHub 连接问题与插件代码无关。

## 使用方式

打开面板后会自动扫描已列出的会话并汇总历史。价格设置直接填写在模型表格下方，四个字段都填完后才显示该模型的估算成本。填入 0 表示该类 Token 确认为免费；价格不确定时请留空。

统计与价格保存在 DSH 当前浏览器配置的本地存储中。插件也会在 ~/.dsh/token-monitor/usage.jsonl 追加新产生的用量元数据，供可选的命令行报告使用。插件不会把提示词、回答正文、工具参数、密钥或工作区内容写进监控数据，也不会向网络发送统计。

Fork 会话会跳过继承的历史前缀，避免把同一次模型调用重复计入。已删除、不可读取或历史页加载失败的会话会显示为不完整扫描；可以点击刷新重试。

## 在 GitHub 网站上上传

如果仓库已经建立：

1. 打开你的仓库，选择 **Add file → Upload files**。
2. 上传本地 dsh-token-monitor 目录里的所有内容，确认 package.json 位于仓库首页，而不是额外嵌套在第二层 dsh-token-monitor/ 文件夹中。
3. 填写提交说明并选择 **Commit changes**。

当前目录已包含预编译的 lib/client.js，上传和安装时不需要运行构建脚本，也不需要在 DSH 的 pnpm 设置中允许额外的构建脚本。

## 维护者构建

仅修改客户端源码后才需要重建：

~~~sh
node ./scripts/build-client.js
node --test
~~~

提交源码时，请一并提交生成的 lib/client.js。这是 DSH 从安装包加载的浏览器入口。

## 仓库结构

~~~text
dsh-token-monitor/
├── cordis.patch.yml
├── lib/client.js
├── package.json
├── rates.example.json
├── scripts/
├── src/
│   ├── client/index.jsx
│   └── index.js
└── README.md
~~~

## 许可证

MIT，见 LICENSE。
