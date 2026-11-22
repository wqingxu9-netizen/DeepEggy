# DeepEggy · 配料表翻译官

拍照/扫码 → OCR 核对 → 通俗释义 → 营养 / 搭配 / 溯源 / 话术 / 个性化提示 → 分享卡片。

## 一、先跑起来（3 步）

1. **解压**这个压缩包到任意目录（路径不要有空格）
2. **确认 Python 版本**：3.10 以上（`python --version`）
3. **启动**（在项目根目录执行）：
   ```bash
   python -m app.backend.main
   ```
   浏览器打开 `http://127.0.0.1:80/`（Windows 需要管理员权限；或设置环境变量 `PORT=8080` 后用 8080 端口）

> 基础功能**零第三方依赖**，不需要 pip install。
> 没有 DeepSeek API Key 也能打开界面（AI 解读会提示错误，可用示例卡片体验其余功能）。

## 二、需要 AI 解读时

设置环境变量后启动（PowerShell）：
```powershell
$env:DEEPSEEK_API_KEY = "你的key"
$env:PORT = "8080"
python -m app.backend.main
```

## 三、接入 OCR（PaddleOCR-VL，需要 NVIDIA GPU）

`app/backend/ocr.py` 已包含 **PaddleOCR-VL** 适配器（队友实现），依赖：
- Python 3.10–3.12（官方要求在 3.8–3.12）
- **NVIDIA 显卡**（CUDA 12.9 驱动）：`ocr.py` 显式使用 `device="gpu:0"`，没有 NVIDIA GPU 的电脑无法运行
- 安装步骤见 `setup_paddleocr.ps1`（自动建 venv、装 paddlepaddle-gpu、装 paddleocr[doc-parser]）
- 模型缓存位置：`data/models/paddlex`（首次运行自动下载）

**没有 NVIDIA GPU 的电脑**：`/api/ocr` 会自动返回 501，前端提示"识别服务未在此环境开启（完整拍照识别见演示视频），可在核对页手动输入配料表"——不影响其他功能演示。

### 接口契约

```python
def recognize(image_base64: str) -> dict:
    """image_base64: 纯 base64（无 data: 前缀），JPEG，长边 ≤1600
    返回：{"text": "识别出的文字", "lowConf": ["不确定的词"], "engine": "PaddleOCR-VL"}
    """
```

- 前端拍照会 POST `/api/ocr`，`main.py` 自动发现并调用 `recognize()`
- 不要改 `main.py` 的路由，放好 `ocr.py` 就生效

## 四、装好 OCR 后打包回传

在项目根目录打包，**排除这些**（避免体积过大/环境不兼容）：
- `.venv/`、`__pycache__/`、`*.pyc`
- `data/trace_cache.sqlite`（缓存，可重建）

Windows 方法：右键项目文件夹 → 发送到 → 压缩(zipped)文件夹（先手动删掉 .venv）

回传时附一句说明：
- 你的 Python 版本 + OCR 库版本（`pip list` 里相关的几行）
- 模型文件放在哪（项目内 `models/`？还是系统缓存目录？）
- 模型加载占多少内存/显存

## 五、目录速查

| 目录 | 内容 |
|---|---|
| `app/backend/` | 后端（main.py 入口 / analyze.py AI解读 / trace.py 溯源 / kb.py 知识库） |
| `app/frontend/` | 前端静态页（index.html + app.js + mock.js + 词条） |
| `data/` | GB2760 知识库、过敏原表、词条、模型 |
| `docs/` | 开发日志、接口说明、结构说明 |
| `app/tests/` | 测试（`python -m pytest app/tests`） |

## 六、注意事项

- 本仓库含 API Key 的**只有 systemd 环境变量**（本仓不含任何 Key）
- 溯源/解读结果均标注置信度，**不编造**；OCR 识别不确定的词会在核对页标出
- 有问题看 `docs/后端接口说明.md`

## 七、时间线自查（赛期 11-20 18:00 → 11-22 18:00）

一条命令即可核对「是不是所有文件都产生于开赛后」：

```bash
python scripts/file_timeline_check.py
```

当前结果（2026-11-22 15:20）：**182 个文件，创建时间与修改时间全部 ≥ 2026-11-20 18:00**。

- 项目文件夹本身创建于 **2026-11-21 09:55**；
- 最早的文件创建/修改于 **2026-11-21 10:18**；
- **创建时间早于开赛：0 个；修改时间早于开赛：0 个。**

逐文件清单（含两列时间与两列判定）在 `docs/文件时间清单.csv`，核查与整理记录在 `docs/整理与时间线核查_2026-11-22.md`。

`data/` 下的 GB 2760 数据资产（`kb.sqlite` / `food_tree.sqlite` / `additives_master.json` / `manual/food_lexicon.json`）
来源是**公开国标数据**（GB 2760-2024 与公开查询库），赛前原型阶段已采集；本次是在赛期内**用构建脚本重跑产出**
（`build_dataset.py` / `build_food_tree.py`，词表由 `scripts/validate_food_lexicon.py` 校验重建），
内容与原文件逐表 sha 一致，构建命令与行数校验见上述记录文档。
这些数据只被 `app/backend/kb.py` 只读引用；代码、界面、交互、AI 编排、抓取脚本均为赛期内从零重建。

## 八、原创声明与 AI 使用说明

提交材料第 ④ 项见 **[原创声明与AI使用说明.md](原创声明与AI使用说明.md)**：赛期内新增了什么、用了哪些模型与工具、数据来源与许可，末尾附可核验材料索引（开发日志 / 时间清单 / 技术说明）。本文为匿名版，不含队员姓名与学号。

