# 发布操作手册

> 生成：2026-11-06
> 当前状态：代码已 commit（`9a7a553`），workflow 已就绪，**等你提供仓库地址**

---

## 一、整个流程分几段（先看懂再动手）

```
① 代码上 GitHub          你建仓库+给 PAT → 我来 push        ← 只有这步需要你给凭据
② 建 publisher           你网页点几下                        ← 我无法代劳（要你的微软账号）
③ 建信任策略             你网页点几下                        ← 我无法代劳
④ 打 tag 发版            GitHub Actions 全自动               ← 之后永久自动化
```

**关键认知**：「发到 GitHub」和「发到 VS Code 市场」是两件事。GitHub 只是自动化流水线的前提。真正上架仍然需要在微软的 publisher 后台建立身份。

---

## 二、为什么推荐 Trusted Publishing 而不是 PAT

| | Trusted Publishing | Azure DevOps PAT |
|---|---|---|
| 需要 Azure 订阅/信用卡 | **不需要** | **需要**（2026 年起新组织强制） |
| 需要保管长期密钥 | 不需要（凭据 15 分钟过期） | 需要，PAT 等于密码 |
| 从本地发版 | 不行，必须在 GitHub Actions | 可以 |
| 受 2027-01-27 全局 PAT 退役影响 | 不受 | 受影响 |

**结论**：如果你没有 Azure 订阅，Trusted Publishing 是唯一可行路径。即使有订阅，它也更好——没有长期密钥要保管。

---

## 三、你需要做的事

### 步骤 1：建 GitHub 仓库

1. 打开 https://github.com/new
2. Repository name 随便填（建议 `vscode-mysql-client-custom`）
3. **不要**勾选 "Add a README" / "Add .gitignore" / "Choose a license"（保持空仓库）
4. Public 或 Private 都行（Trusted Publishing 都支持）
5. 建完把地址发给我，形如 `https://github.com/你的用户名/vscode-mysql-client-custom`

### 步骤 2：给 PAT（二选一）

**方式 A：给我 PAT，我全程操作**

1. 打开 https://github.com/settings/tokens?type=beta （Fine-grained token）
2. Generate new token
3. Repository access → 选 **Only select repositories** → 选中刚建的仓库
4. Permissions：
   - **Contents: Read and write**（push 代码）
   - **Workflows: Read and write**（提交 `.github/workflows/`）
5. Expiration：建议 **7 天**（用完就吊销）
6. 生成后复制 `github_pat_...` 发我

**方式 B：不给 PAT，你自己 push**

我给你现成的命令，你在终端粘贴执行。见第五节。

### 步骤 3：建 publisher

1. 打开 https://marketplace.visualstudio.com/manage
2. 用微软账号登录
3. **Create publisher**：
   - ID：建议 `junbiaojin`（和 `package.json` 里现有一致）
   - Name：随便填，显示用
4. 注意：**ID 创建后不能改**

### 步骤 4：建 Trusted Publishing 策略

1. 在 publisher 页面找到 **Trusted Publishing** → **Create**
2. 填：
   - Policy name：`github-release`
   - Repository owner：你的 GitHub 用户名
   - Repository：仓库名
   - Workflow：`release.yml`
   - Environment：留空
3. 保存

> ⚠️ 如果仓库是 **Private**，策略创建后 **48 小时内**必须成功跑一次 workflow，否则策略失效。Public 仓库无此限制。

### 步骤 5：告诉我可以发版

我打 tag `v0.1.0` 并 push，GitHub Actions 自动构建 + 发布。约 3-5 分钟出结果。

---

## 四、我已经做完的事（不用你管）

| 项 | 状态 |
|---|---|
| 代码清理 | 194 文件 / 15,781 行删除，依赖 39→26 |
| 提交 | `9a7a553`，252 文件 |
| README / README_CN 重写 | 删掉上游链接、遥测声明、Redis/ES 宣传 |
| XSS 修复 | CellViewer 键名注入 |
| 回归验证 | 93 个断言全过 |
| `.github/workflows/release.yml` | 已就绪，支持 Trusted Publishing 与 PAT 两种模式 |
| 推送前敏感信息扫描 | 零命中（无 .env / 私钥 / token / vsix） |

---

## 五、如果不想给 PAT：你自己执行这些命令

在 `C:\Users\FFIT\ZCodeProject\dbclient-work\repo` 目录下：

```bash
# 1. 把 remote 改成你的仓库（保留上游为 upstream，方便以后对照）
git remote rename origin upstream
git remote add origin https://github.com/你的用户名/你的仓库名.git

# 2. 提交 workflow
git add .github/workflows/release.yml
git commit -m "ci: add release workflow"

# 3. 推送（会提示输入用户名和 PAT，密码位置填 PAT）
git push -u origin main

# 4. 打 tag 触发发版
git tag v0.1.0
git push origin v0.1.0
```

---

## 六、几个需要注意的点

### 6.1 版本号

当前 `package.json` 是 **3.9.8**。建议改成 **0.1.0** 或 **1.0.0**：

- 沿用 3.9.8 会让用户以为是上游同一个东西，也容易被判定混淆
- 改版本号本身不影响任何功能

**但没有改**，因为改 `name` 会导致 `globalStoragePath` 变化，**你现有的连接配置会丢**。如果只改 `version` 不改 `name`，配置不受影响。

### 6.2 扩展名与商标

当前 `displayName` 是 **MySQL Custom**。风险：

- 微软发布文档明确写「**Don't use brand names in the name of your extension**」
- Oracle 政策允许 `MyTool for MySQL` 这种句式，禁止把 MySQL 当产品名主体
- 但 Marketplace 上叫 `MySQL` 的扩展有 439 个在跑（含 304 万安装的 `cweijan.vscode-mysql-client2`），实际是「不告不理」

**MySQL Custom** 属于中间偏激进，实际大概率没事。要稳妥就改成 `DBClient — MySQL Client`，但改 `name` 要迁移连接配置。

### 6.3 新 publisher 被误判

新 publisher 首次发布常被自动风控判 "suspicious content"（vsmarketplace 仓库有 44 个此类 issue）。

本次的包已经清干净了：无隐藏目录、无 secrets、无二进制 exe、无 test 文件。触发概率会低不少。若真被误判，只能发邮件 `VSMarketplace@microsoft.com` 申诉。

### 6.4 package-lock.json

上游把它写进了 `.gitignore`，所以仓库里没有 lock 文件，workflow 用 `npm install` 而不是 `npm ci`。这意味着每次构建的依赖版本可能有细微差异。

想锁死的话：删掉 `.gitignore` 里的 `package-lock.json` 那一行，本地 `npm install` 生成后提交。

### 6.5 开源协议合规

MIT 要求保留原版权声明，`LICENSE` 里已有：

```
Copyright (c) 2019-2021 Weijan Chen
Copyright (c) 2026 junbiaojin (modifications)
This product is a derivative work based on cweijan/vscode-database-client version 3.9.8
```

README 里也声明了衍生关系。这部分**不能删**。

---

## 七、发布之后的日常

```bash
# 改代码
git add -A && git commit -m "..."
git push

# 发新版（改 package.json 的 version 后）
git tag v1.0.1
git push origin v1.0.1
```

其余全自动。

---

## 八、如果 Trusted Publishing 走不通

备选方案：

1. **Azure DevOps PAT** —— 需要 Azure 订阅（要信用卡）
2. **只发 Open VSX** —— 不需要微软账号体系：
   - 注册 https://accounts.eclipse.org/user/register （**必须填对你的 GitHub Username**）
   - 用 GitHub 登录 open-vsx.org
   - Settings → Log in with Eclipse → 同意 Publisher Agreement
   - Settings → Access Tokens → 生成 token（**只显示一次**）
   - `npx ovsx create-namespace junbiaojin -p <token>`
3. **纯 GitHub Release** —— 不发任何市场，只在 GitHub 上挂 vsix 供手动下载安装：
   ```bash
   code --install-extension xxx.vsix
   ```
   这个方案**零审核、零门槛、立即可用**，适合个人自用或小范围分发。