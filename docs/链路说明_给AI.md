# DeepEggy 配料表解读 · 条码查询与配料表获取链路说明

> 交接文档：给其他 AI / 开发者接手时看。包含项目架构、数据源调研结论、已实现方案、API 清单、已知限制与待办。
> 更新时间：2026-11-22

---

## 一、项目是什么

**DeepEggy · 看得懂的配料表**——首届 CAU AgriHackathon 参赛作品（方向二：生命系统）。

用户拍/扫超市食品 → 识别配料表 → 逐项大白话解释 + 营养折算 + 过敏原提醒 + 营销话术拆穿 + 溯源 + 分享卡片。

- 团队：DeepEggy（4 人，前端/后端/数据/视觉分工）
- 项目路径：`D:\deepseek工作区\AgriHackathon_DeepEggy`
- 在线 Demo：`https://182-92-231-87.sslip.io/`（HTTP 也开 80 端口）
- 截止：2026-11-22 18:00

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 输入路径（三条，最终都汇到「配料表文本」）                        │
│                                                             │
│ A. 拍配料表照片 → 百度 OCR（高精度）→ 配料表文本                │
│ B. 微信扫条码 → 截图 → 百度 OCR → 商品名/品牌                   │
│    → Tavily 联网搜"品牌 商品名 配料表" → 提取配料表文本          │
│ C. 项目内扫条码（浏览器 BarcodeDetector）                       │
│    → 查商品库（OpenFoodFacts）→ 有配料表直接用                  │
│    → 没有 → Tavily 搜配料表（同 B）                             │
│                                                             │
│         ↓ 配料表文本                                          │
│  AI 解读（DeepSeek + GB2760 知识库 + 143 条词条 + 过敏原匹配）   │
│                                                             │
│  结果页：成分释义 / 营养 / 搭配 / 口碑 / 溯源 / 话术 / 为你      │
└─────────────────────────────────────────────────────────────┘
```

**技术栈**：
- 前端：纯静态 HTML+JS（零构建），Console/暖纸 v2 主题，移动端优先
- 后端：Python 标准库 `http.server`（零第三方依赖，除 OCR 可选依赖）
- AI：DeepSeek API（`deepseek-chat`，OpenAI 兼容）
- OCR：百度智能云高精度 OCR（IAM Bearer 认证）
- 搜索：Tavily API（联网搜配料表/口碑）
- 部署：阿里云轻量 2C2G Ubuntu 24.04，systemd 双服务（80 HTTP + 443 HTTPS 自签名）

---

## 三、数据源调研结论（重要）

### 3.1 中国物品编码中心（gds.org.cn）—— 数据最全但需登录

- 微信扫条码显示的「商品名/规格/品牌/企业/中国物品编码中心」就来自这里
- 官方平台 `https://www.gds.org.cn` 的查询 API 已逆向出来（SPA + BFF 架构）：
  ```
  GET https://bff.gds.org.cn/gds/searching-api/ProductService/ProductListByGTIN
      ?PageSize=30&PageIndex=1&SearchItem={14位GTIN}
  ```
- **未登录返回**：`{"Code":40000,"Msg":"已超出您的检索结果浏览范围,请登录后检索"}`
- 结论：**需要登录账号（企业会员）**才能查询；个人/网页端拿不到完整数据
- 微信扫码能显示是微信与编码中心合作（特殊权限），普通网页无法调用微信扫一扫（需公众号 JS-SDK + 认证域名，成本高）

### 3.2 OpenFoodFacts（开源食品数据库）

- 免 key 开源 API，全球 300 万+ 商品
- **中国商品覆盖低**：`countries_tags_en=china` 只有 **1802 条**，已抓 837 条存档（`data/openfoodfacts_cn.json`，含 515 条国内条码 69 开头、242 条带中文配料表）
- 用途：项目内扫码的本地商品库 + 在线单条查询（`world.openfoodfacts.org/api/v2/product/{code}.json`）
- 注意：服务器 IP 曾被限流（503/401），已抓的 837 条为最终数据

### 3.3 搜索引擎（免费抓取）

| 搜索引擎 | 状态 |
|---|---|
| 百度 | 反爬严重（返回"安全验证"页，0 结果） |
| 必应 | 反爬（返回字典垃圾/降级结果） |
| 360 | 反爬（0 结果） |
| 搜狗 | 返回导航文本（降级） |
| **头条搜索**（so.toutiao.com） | ✅ 可用（无风控） |
| **神马搜索**（m.sm.cn） | ✅ 可用 |
| **夸克搜索**（quark.sm.cn） | ✅ 可用 |
| DuckDuckGo | ❌ 202 验证页 |

- 用于：口碑抓取（评价原文）、配料表搜索兜底
- 代码：`app/backend/reviews.py`（search_baidu/search_bing/search_360/search_sogou + 文本提取）

### 3.4 Tavily（当前主力联网搜索）

- API：`POST https://api.tavily.com/search`
- 参数：`{"api_key": "...", "query": "...", "max_results": 5, "include_raw_content": true}`
- `include_raw_content=true` 返回完整网页正文，**配料表提取成功率大幅提升**
- 实测：输入"达利园 香蕉味卷式夹心糕点"→ 搜到 foodaily.com 商品页 → 提取真实配料表 → 15 项成分解读 ✅
- 免费额度 1000 次/月

---

## 四、已实现的 API（后端 main.py）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/scan-barcode?code=xxx` | 条码查询：内置 4 款 → OpenFoodFacts 离线 837 条 → OpenFoodFacts 在线 → 探数 API（需 key） |
| POST | `/api/analyze` | **核心**：配料表文本 → AI 结构化解读（含 GB2760 知识库 + 词条 + 过敏原注入） |
| POST | `/api/analyze-barcode` | **扫码/微信链路**：{code,name,brand,category,spec} → Tavily 搜配料表 → AI 提取 → 解读；搜不到则 AI 按品牌品类推断（标注"推断"） |
| POST | `/api/ocr` | 图片 base64 → 百度 OCR 文字（详见下） |
| POST | `/api/reviews` | 商品口碑：多源搜索抓评价 → AI 归纳（主流评价/口味画像/同好推荐/吐槽/吃法脑洞） |
| POST | `/api/review-page` | 评价原文：{url} → 服务端抓网页正文 → 项目内展示 |
| GET | `/api/search-product?name=xxx` | 商品名模糊搜索本地库（口碑"同好推荐"联动） |
| GET | `/api/products` | 商品索引（清洗后约 360 款 + 品类标签） |
| POST | `/api/trace` | 溯源证据链 |

**OCR 接口细节**（`/api/ocr`）：
- 请求：`{"imageBase64": "纯base64无前缀"}`
- 优先级：本地 PaddleOCR-VL（GPU，有则用）→ **百度云 OCR**（IAM Bearer）→ 501
- 百度调用：
  ```
  POST https://aip.baidubce.com/rest/2.0/ocr/v1/general_accurate
  Authorization: Bearer bce-v3/ALTAK-...（百度智能云 IAM API Key）
  body: image={base64}
  ```
- 返回：`{"text": "...", "lowConf": [], "engine": "Baidu-OCR-accurate"}`
- 错误码已翻译成人话（216630 → "图片里没认到清晰文字，请靠近一点"）

---

## 五、环境变量 / Key（服务器 systemd 配置）

```ini
DEEPSEEK_API_KEY=sk-...          # AI 解读
BAIDU_OCR_IAM_KEY=bce-v3/ALTAK-...  # 百度 OCR（IAM Bearer 认证）
TAVILY_API_KEY=tvly-...          # 联网搜索（搜配料表）
# 可选：TANSHU_KEY（探数条码 API）、BOCHA_API_KEY（博查搜索）
```

**注意**：百度 OCR 用的是新版 IAM Key（`bce-v3/ALTAK-...` 格式），认证方式为 `Authorization: Bearer {key}`，**不是**旧版 access_token 方式（旧版应用 Key 报 `unknown client id`）。

---

## 六、前端关键文件

```
app/frontend/
├─ index.html      页面结构（首页三入口：扫码/拍配料表/微信扫了码）
├─ app.js          全部交互（扫码/OCR/结果渲染/口碑/过敏原/分享卡片）
├─ mock.js         4 款示例商品（演示用）
├─ allergens.js    35 类过敏原（14 国标核心 + 21 扩展，含别名/交叉反应）
├─ ingredient-glossary.js  143 条配料通俗词条
└─ style.css       暖纸 v2 主题
```

**关键前端逻辑**：
- `analyzeByText(text, meta, via)`：配料表文本 → POST /api/analyze → openResult
- `analyzeBarcodeWeb(prod, code)`：商品名/品牌 → POST /api/analyze-barcode → openResult
- `renderReviews(r)`：口碑渲染（口味画像条形图/评价原文/同好推荐/创新吃法）
- 微信截图入口：拍截图 → /api/ocr → `parseWechatOcr()` 提取商品名/品牌 → analyzeBarcodeWeb
- 缓存控制：后端 `end_headers` 加 no-cache，避免用户拿到旧前端

---

## 七、已知限制（踩过的坑）

1. **微信扫一扫不能网页调用**：微信 App 独有；网页要调用需公众号 JS-SDK（认证 300 元/年 + 域名备案），已放弃
2. **编码中心 API 需登录**：gds.org.cn 查询接口未登录返回"超出检索结果浏览范围"；微信能显示是合作权限
3. **搜索引擎反爬**：百度/必应/360/搜狗对服务器 IP 风控（返回验证页/垃圾结果）；只有头条/神马/夸克稳定
4. **OpenFoodFacts 中国商品少**：1802 条，已抓 837（46%），IP 限流后未补抓
5. **配料表在图片里**：很多商品的配料表只存在于商品详情页图片中，文本搜索拿不到——Tavily 返回的网页正文里有时有，成功率约 50-60%，失败时走 AI 推断（明确标注，不冒充）
6. **服务器 TLS**：gds.org.cn 的 TLS 老旧（Python 默认 SSL 握手失败），需 `ssl.PROTOCOL_TLS_CLIENT` + `set_ciphers("DEFAULT@SECLEVEL=1")`
7. **前端缓存**：改了前端后用户可能拿到旧 JS——后端已加 no-cache 头
8. **服务器内存**：2G，跑不了 GPU OCR；VS Code Remote SSH 残留进程会吃 700MB，需定期清

---

## 八、部署

- 服务器：阿里云轻量 `182.92.231.87`（Ubuntu 24.04，2C2G）
- 服务：`deepeggy.service`（80 HTTP）+ `deepeggy-https.service`（443 HTTPS 自签名证书 `/root/certs/`）
- 代码：`/root/deepeggy`（项目目录）
- 启动：`python3 -m app.backend.main`（env：PORT/TLS_CERT/TLS_KEY/DEEPSEEK_API_KEY/BAIDU_OCR_IAM_KEY/TAVILY_API_KEY）
- 部署方式：本地打包 tar.gz → scp → 解压 → `systemctl restart`
- SSH 密钥：`D:\deepseek工作区\.ssh\agrihack_key_nopass`

---

## 九、待办（截止前）

1. **录屏**：队友 GPU 电脑跑完整流程（PaddleOCR-VL 本地识别），3 分钟
2. **200 字简介**：产品介绍
3. **原创声明 + AI 使用说明**：基于 `docs/开发日志.md`（278 行，按小时记录）
4. **GitHub/Gitee 仓库上传**（代码打包：`AgriHackathon_DeepEggy_交给队友.zip`）
5. 最终部署确认 + 提交（17:30 前）

## 十、测试命令

```bash
# 健康检查
curl https://182-92-231-87.sslip.io/api/health

# 条码查询（娃哈哈 AD 钙奶）
curl "https://182-92-231-87.sslip.io/api/scan-barcode?code=6902083881085"

# 扫码/微信链路（商品名 → 联网搜配料表 → 解读）
curl -X POST https://182-92-231-87.sslip.io/api/analyze-barcode \
  -H "Content-Type: application/json" \
  -d '{"name":"香蕉味卷式夹心糕点","brand":"达利园","category":"糕点","spec":"200克"}'

# OCR 测试（传 base64 图片）
curl -X POST https://182-92-231-87.sslip.io/api/ocr \
  -H "Content-Type: application/json" \
  -d '{"imageBase64":"..."}'

# 口碑
curl -X POST https://182-92-231-87.sslip.io/api/reviews \
  -H "Content-Type: application/json" \
  -d '{"name":"经典原味薯片","category":"马铃薯薯片"}'
```

---

## 十一、给接手 AI 的建议

1. **优先保证"拍配料表 → OCR → 解读"这条主路径稳定**（最可靠，已全部通）
2. 微信扫码链路（截图 → OCR 商品名 → Tavily 搜配料表）是差异化亮点，但依赖 Tavily 配额（1000 次/月）
3. 所有联网数据必须标注来源（"配料表来自联网检索（域名）" / "AI 推断"），**不能编造**
4. 前端改动后记得部署 + 让用户强制刷新（或依赖 no-cache 头）
5. 服务器 2G 内存，不要装 GPU 依赖；PaddleOCR-VL 只能在队友 GPU 电脑本地跑（录屏用）
