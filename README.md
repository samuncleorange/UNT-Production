# UNT 产能识别

把手写的晶元产能记录拍照上传，由 AI 识别为标准格式文本：

- 首页有**纸笔记录格式指引**，从源头统一写法，提高识别准确率
- 上传一张或多张照片（拍照 / 选图 / 拖拽 / 粘贴），自动调用后台配置的视觉模型
- **后台识别**：上传完成即可离开页面，识别在服务器排队进行，回来自动显示结果；服务重启后未完成的任务会继续；页面上有「识别记录」可查看历史结果和原图
- 输出标准格式文本，**一键复制**，也可直接在网页上修改
- **合计由代码逐行相加**，不使用 AI 的加法；纸上若写了合计，会与验算结果比对
- **待人工核对**区：列出 AI 标记的模糊/涂改字段，以及代码规则检查出的异常（批次号格式、片数越界、重复批次等），可逐条勾选"已核对"

输出示例：

```
10.18 6:00 - 10.19 6:00生产情况：

#07
1. BP1592.02 (12) B473

#08
1. BE2751 (11) B586
...

共计：152片
```

## VPS 部署

需要 Node.js 18 及以上。

```bash
# 1. 拉代码
git clone https://github.com/samuncleorange/UNT-Production.git
cd UNT-Production

# 2. 安装依赖
npm install --omit=dev

# 3. 配置
cp .env.example .env
nano .env        # 至少填写 PORT、ACCESS_CODE、ADMIN_PASSWORD，AI 配置可以之后在后台填

# 4. 安装为系统服务（开机自启、崩溃自动重启）
sudo ./install-service.sh
```

然后访问 `http://服务器IP:端口`（记得在云服务器安全组/防火墙放行该端口）。

常用命令：

```bash
systemctl status unt-production      # 查看状态
journalctl -u unt-production -f      # 实时日志
sudo systemctl restart unt-production   # 重启（改了 .env 后需要）
```

也可以用 pm2 代替 systemd：`pm2 start ecosystem.config.js && pm2 save && pm2 startup`，二选一即可。

### 以后更新

本地改完代码 push 到 GitHub 后，在 VPS 上：

```bash
cd UNT-Production && ./update.sh
```

## AI 接口配置

支持任何**兼容 OpenAI Chat Completions 格式**且**支持图片输入**的模型，两种配置方式：

1. 后台页面：`http://服务器IP:端口/admin`，用 `.env` 里的 `ADMIN_PASSWORD` 登录，可在线修改并"测试连接"，保存后立即生效（存放在 `data/config.json`，不会提交到 git）。
2. `.env` 文件：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。

| 服务 | AI_BASE_URL | AI_MODEL 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| 其它中转 / OneAPI | 中转地址 + `/v1` | 按中转提供的名称 |

手写体识别对模型要求较高，建议用各家最强的视觉模型。后台的「补充提示词」可以写本厂特有规则（如"型号只有 B228、B339、B342、B473、B586"），能明显减少误识别。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，默认 3000 |
| `SHIFT_START` | 交班时间，默认 `6:00`。纸上只写 `10.18~10.19` 时自动补全为 `10.18 6:00 - 10.19 6:00` |
| `ACCESS_CODE` | 访问码。设置后识别前需输入，**防止外人刷 API 额度，公网部署强烈建议设置** |
| `ADMIN_PASSWORD` | 后台密码，不设置则后台不可用 |
| `JOB_CONCURRENCY` | 同时识别的任务数，默认 2 |
| `JOB_KEEP_DAYS` | 识别记录与照片保留天数，默认 30，保存在 `data/jobs/` |
| `AI_*` | AI 接口默认配置，后台保存的配置优先 |

## 本地开发

```bash
npm install
npm run dev     # 模拟模式（AI_MOCK=1），不调用真实 AI，返回 test/fixtures 里的示例结果
npm test        # 单元测试：格式化、代码验算、时间段规范化、规则校验
```

## 说明

- 一键复制在非 HTTPS 下会自动回退到兼容方式；如需最佳体验，可用 Nginx/Caddy 反代并配置 HTTPS。
- 照片在手机上先压缩再上传，服务器保存在 `data/jobs/`，超过保留天数自动删除。
- 能看到识别记录的人就是知道访问码的人，所以公网部署务必设置 `ACCESS_CODE`。
