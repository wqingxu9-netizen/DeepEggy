/* 演示数据（前端原型阶段）
   后端接入后由 /api/scan-barcode、/api/analyze、/api/trace 替换本文件。
   条码为占位编号；数值取同类产品的常见标注量级，用于演示界面与计算逻辑，非实测某一款商品。 */

(function (w) {
  'use strict';

  var PRODUCTS = {
    '6902000100029': {
      id: 'maidong',
      name: '脉动 水蜜桃口味维生素饮料',
      brand: '脉动',
      spec: '600 ml / 瓶',
      volume: 600,
      barcode: '6902000100029',
      category: '维生素饮料',
      verdict: { level: 'caution', label: '适量更合适', why: '维生素是真的，但一瓶 35g 糖也是真的，别把它当水喝。' },
      keys: [
        { l: '糖', v: '34.8', u: 'g / 瓶', hi: true },
        { l: '能量', v: '143', u: 'kcal / 瓶' },
        { l: '钠', v: '120', u: 'mg / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '配料的第一位，说明这瓶绝大部分是水。' },
        {
          name: '白砂糖', flag: 'yellow', role: '甜味', what: '最常见的添加糖，蔗糖。',
          why: '提供甜味和能量，身体代谢成葡萄糖，快但没营养。',
          caution: '一瓶约 18g，加上果葡糖浆后总糖接近每日理想上限的 1.4 倍。',
          dose: { amount: '18 g', limit: '游离糖建议 < 25 g/天（WHO 理想值）', pct: 72, bar: 'warn',
                  note: '这一项就占了理想上限的 72%。按 WHO 的宽松上限 50g 算，也占 36%。' }
        },
        {
          name: '果葡糖浆', flag: 'yellow', role: '甜味', what: '玉米淀粉做的糖浆，一半是果糖，比蔗糖还甜、还便宜。',
          why: '和白砂糖叠加使用，甜度上去了，糖的总量也跟着上去。',
          caution: '果糖不走「饱腹」那条路，喝了不太会觉得「吃过了」，容易一路喝下去。',
          dose: { amount: '16.8 g', limit: '与白砂糖合并计入游离糖', pct: 67, bar: 'warn',
                  note: '两种糖合计 34.8g／瓶，超过 WHO 理想上限 25g，占宽松上限 50g 的 70%。' }
        },
        { name: '柠檬酸', flag: 'green', role: '酸度调节', what: '让口感更清爽的有机酸，柑橘里就有。', why: '调酸甜比，顺便有点防腐作用。' },
        {
          name: '维生素 C', flag: 'green', role: '营养强化', what: '抗坏血酸，人体自己造不出来，得靠吃。',
          why: '一瓶 72mg，约等于一个猕猴桃的量。',
          dose: { amount: '72 mg', limit: '每日推荐 100 mg', pct: 72, bar: 'good',
                  note: '补维 C 是真的，但为它喝下 35g 糖不太划算，吃个橙子、猕猴桃更值。' }
        },
        { name: '烟酰胺（维生素 B3）', flag: 'green', role: '营养强化', what: 'B 族维生素的一种，参与能量代谢。', why: '添加量很小，正常饮食就够，不用为它买单。' },
        { name: '维生素 B6', flag: 'green', role: '营养强化', what: '参与蛋白质和神经递质代谢。', why: '同上，日常饮食里不缺。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的水蜜桃香味，不是果汁。', why: '让「水 + 糖 + 酸」喝起来像水果味。', caution: '配料表里没有水蜜桃，甜香来自香精；仅凭成分名称无法判断具体用量。' },
        { name: '柠檬酸钠', flag: 'green', role: '酸度调节', what: '柠檬酸的钠盐，缓冲酸味。', why: '让酸不那么「刺」。' }
      ],
      nutrition: [
        { name: '能量', per100: '100 kJ', whole: '600 kJ ≈ 143 kcal', nrv: 7, cm: '一瓶约等于半碗米饭。' },
        { name: '碳水化合物', per100: '5.8 g', whole: '34.8 g', nrv: 12, cm: '基本全是糖，没有膳食纤维。' },
        { name: '钠', per100: '20 mg', whole: '120 mg', nrv: 6, cm: '比纯饮料高一点，补出汗流失的那部分。' },
        { name: '蛋白质', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '脂肪', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' }
      ],
      equiv: [
        { big: '≈ 9 块', small: '方糖（4g／块）' },
        { big: '≈ 22 分钟', small: '慢跑消耗掉这瓶' },
        { big: '72%', small: '每日维 C 推荐量' }
      ],
      trace: {
        found: true, place: '广东东莞，达能食品工厂',
        lines: ['品牌官网公示的生产厂址：广东省东莞市', '原料产地官网未逐项公示（水蜜桃为香精风味，非果肉）'],
        source: '品牌官网产品页，抓取时间 2026-11-21',
        note: '联网搜索取到的是官网公示信息；批次差异以包装标注为准。'
      },
      tricks: [
        {
          claim: '「维生素饮料」', ok: false,
          truth: '维生素确实加了，一瓶能补到每日维 C 推荐量的 72%。但「维生素饮料」这个品类名，容易让人忽略它同时是一瓶 35g 糖的甜饮料。',
          basis: '每 100mL 含糖 5.8g × 600mL = <b>34.8g</b>；WHO 游离糖理想上限 <b>25g/天</b>'
        },
        {
          claim: '「运动后补水」', ok: true,
          truth: '出汗后补糖和钠是合理的，短时间的中高强度运动后喝没问题。日常坐着当水喝就不划算了。',
          basis: '钠 120mg／瓶，糖 34.8g／瓶，属于低渗偏甜的补能饮料'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'risk', text: '一瓶 34.8g 糖且都是游离糖，升糖快。这类饮料建议不选，或只喝小半瓶。' },
        { tag: '减脂', level: 'risk', text: '143kcal 是「液体热量」，不顶饱，很容易变成一天里的额外热量。' },
        { tag: '高强度运动后', level: 'tip', text: '大量出汗后 30 分钟内喝，糖和钠都用得上，这时候它是合适的选择。' },
        { tag: '儿童', level: 'tip', text: '单次不超过 200mL，别当作日常饮水替代白开水。' }
      ],
      pairs: [
        { with: '正餐主食（米饭、面条）', why: '一餐里已经有大量碳水，再加这瓶，糖的总量容易翻倍。建议错开到两餐之间。' },
        { with: '其他甜饮料、甜点（同日）', why: '一瓶已到 WHO 宽松上限的 70%，再叠加任何含糖食物都会直接破顶。' }
      ],
      buzz: {
        flavor: ['水蜜桃香（香精调味，非果汁）', '偏甜，酸度轻', '无气泡，口感接近淡果汁'],
        topics: [
          { t: '「维生素饮料」值不值得买', d: '争议集中在：维 C 是真的，但一瓶 35g 糖也是真的。这页把两项都算出来，交给你判断。' },
          { t: '运动后喝它补水合适吗', d: '短时间中高强度运动后补糖补钠合理；日常坐着当水喝，是最常见的吐槽点。' }
        ]
      },
      compare: {
        metric: '含糖量 g / 100mL',
        rows: [
          { name: '可乐', value: 10.6 }, { name: '脉动', value: 5.8, me: true },
          { name: '维他命水', value: 5.2 }, { name: '尖叫', value: 6.0 }, { name: '东方树叶', value: 0 }
        ]
      },
      ocrText: '配料表：水、白砂糖、果葡糖浆、柠檬酸、食用香精、维生素C、烟酰胺、盐酸吡哆醇、柠檬酸钠 产品标准号：GB 7101 生产商：达能（中国）食品饮料有限公司 厂址：四川省成都市邛崃市工业园区',
      lowConf: ['盐酸吡哆醇', '柠檬酸钠']
    },

    '6970220100058': {
      id: 'yuanqi',
      name: '元气森林 白桃味气泡水',
      brand: '元气森林',
      spec: '480 ml / 瓶',
      volume: 480,
      barcode: '6970220100058',
      category: '苏打气泡水',
      verdict: { level: 'good', label: '可按需选择', why: '「0 糖 0 脂 0 卡」的标注有国标依据，甜味来自代糖。喝多了可能胀气。' },
      keys: [
        { l: '糖', v: '0', u: 'g / 瓶' },
        { l: '能量', v: '0', u: 'kJ / 瓶' },
        { l: '赤藓糖醇', v: '未标注', u: '包装未提供含量' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '气泡水的基底。' },
        { name: '二氧化碳', flag: 'green', role: '气泡', what: '打进去的气，产生「杀口」的泡沫感。', why: '不提供任何热量。' },
        {
          name: '赤藓糖醇', flag: 'yellow', role: '代糖（甜味主体）', what: '一种糖醇，甜度约为蔗糖的 65%，热量几乎为零。',
          why: '它大部分随尿原样排出，不参与血糖代谢，所以能标「0 卡」。',
          caution: '糖醇的耐受情况因人而异，部分人摄入较多后可能出现腹胀等肠胃不适。'
        },
        { name: '三氯蔗糖', flag: 'yellow', role: '代糖（补甜）', what: '高倍甜味剂，甜度约蔗糖 600 倍，用量极小。', why: '和赤藓糖醇搭配，把甜度补足、口感做得更接近真糖。', caution: '配料表名称不显示本产品中的实际使用量；相关要求需结合产品类别与适用标准核对。介意人工甜味剂的人可按偏好选择。' },
        { name: '乳酸', flag: 'green', role: '酸度调节', what: '发酵常见的有机酸，提供柔和的酸。', why: '平衡甜味，让口感不发腻。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的白桃香。', why: '配料里没有白桃果汁。', caution: '「白桃味」= 香精味，不是桃子味。' },
        { name: '碳酸氢钠', flag: 'green', role: '酸度调节', what: '小苏打。', why: '调节酸碱度，稳定气泡。' }
      ],
      nutrition: [
        { name: '能量', per100: '0 kJ', whole: '0 kJ', nrv: 0, cm: '「0 能量」的标示条件需结合该产品生产日期适用的标准核对。' },
        { name: '蛋白质', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '脂肪', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '碳水化合物', per100: '0 g', whole: '0 g', nrv: 0, cm: '赤藓糖醇按国标可不计入碳水化合物总量。' },
        { name: '钠', per100: '24 mg', whole: '115 mg', nrv: 6, cm: '来自碳酸氢钠和原料，量不大。' }
      ],
      equiv: [
        { big: '0 块', small: '方糖当量' },
        { big: '未标注', small: '赤藓糖醇每瓶含量' },
        { big: '因人而异', small: '糖醇耐受体验' }
      ],
      trace: {
        found: true, place: '安徽芜湖，元气森林自建工厂',
        lines: ['官网公示的生产基地含安徽芜湖、湖北咸宁、广东肇庆', '代糖原料（赤藓糖醇）多为玉米发酵来源，官网未公示具体供应商'],
        source: '品牌官网，抓取时间 2026-11-21',
        note: '批次生产厂以包装标注为准。'
      },
      tricks: [
        {
          claim: '「0 糖 0 脂 0 卡」', ok: true,
          truth: '示例记录的能量和糖均标为 0，甜味来源列有赤藓糖醇和三氯蔗糖；宣称是否适用，仍需核对该批次标签与生产日期对应的标准。',
          basis: '本示例未记录生产日期，暂不套用固定阈值；需按该批次适用标准核对「0」宣称'
        },
        {
          claim: '「0 蔗糖」≠「0 糖」', edu: true,
          truth: '这是整个品类最该记住的一条：只写「0 蔗糖」时，可能加了果糖、葡萄糖、麦芽糖浆，照样是糖。2021 年该品牌「0 蔗糖」乳茶争议就是这个坑。买的时候看营养成分表的「糖」那一栏，别看正面大字。',
          basis: '先对照配料表与营养成分表，再依据该产品生产日期对应的适用标准核对宣称'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'tip', text: '不含糖、不升血糖，是这类人群相对可选的甜饮料。' },
        { tag: '减脂', level: 'tip', text: '0 能量，替代含糖饮料是划算的。注意别因为它「0 卡」就一天喝好几瓶。' },
        { tag: '肠胃敏感 / IBS', level: 'risk', text: '糖醇的耐受情况因人而异；如饮用后出现肠胃不适，可减少摄入或停止饮用。' },
        { tag: '儿童', level: 'tip', text: '偶尔喝没问题，但别让它养成对甜味的依赖。' }
      ],
      pairs: [
        { with: '高脂正餐', why: '气泡＋冷饮容易加重饱胀感，肠胃敏感的人会更明显。' },
        { with: '一口气多瓶', why: '糖醇的耐受情况因人而异；如果对糖醇较敏感，可以少量尝试并留意自身感受，出现不适时减少或停止摄入。' }
      ],
      buzz: {
        flavor: ['白桃香（香精调味）', '甜度高，代糖后味有人敏感', '气泡足，冷藏后更「杀口」'],
        topics: [
          { t: '糖醇对肠胃的影响因人而异', d: '公开页面中有用户提到腹胀等体验；个体反应不同，本页不提供统一的耐受量判断。' },
          { t: '「0 糖 0 卡」是不是文字游戏', d: '这一款标注有国标依据；真正容易混淆的是同品牌乳茶的「0 蔗糖」，两个概念别混。' }
        ]
      },
      compare: {
        metric: '含糖量 g / 100mL',
        rows: [
          { name: '可乐', value: 10.6 }, { name: '脉动', value: 5.8 },
          { name: '维他命水', value: 5.2 }, { name: '元气森林气泡水', value: 0, me: true }, { name: '东方树叶', value: 0 }
        ]
      },
      ocrText: '配料表：水、二氧化碳、赤藓糖醇、乳酸、食用香精、三氯蔗糖、碳酸氢钠 产品标准号：GB/T 10792 生产商：元气森林（北京）食品科技集团有限公司 厂址：北京市朝阳区酒仙桥',
      lowConf: ['三氯蔗糖', '碳酸氢钠']
    },

    '6925303730574': {
      id: 'milktea',
      name: '阿萨姆奶茶 原味',
      brand: '统一',
      spec: '500 ml / 瓶',
      volume: 500,
      barcode: '6925303730574',
      category: '奶茶饮料（GB/T 21733）',
      verdict: { level: 'bad', label: '谨慎购买', why: '名字叫奶茶，奶主要来自植脂末——标签写明奶粉只需 ≥1%；蛋白质 0.6g/100mL，整瓶 46g 碳水基本全是糖。' },
      keys: [
        { l: '糖（推算）', v: '≈ 40', u: 'g / 瓶', hi: true },
        { l: '能量', v: '275', u: 'kcal / 瓶', hi: true },
        { l: '蛋白质', v: '3.0', u: 'g / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '排在第一位，这瓶的大头是水。' },
        {
          name: '白砂糖', flag: 'red', role: '甜味（糖的主要来源）', what: '最常见的添加糖，蔗糖。',
          why: '排第二位，甜度和整瓶 46g 碳水主要靠它。',
          caution: '标签没有单列「糖」这一行，按配料排序推算，整瓶糖约 40g，接近 10 块方糖。',
          dose: { amount: '≈ 40 g', limit: '游离糖建议 < 25 g/天（WHO 理想值）', pct: 100, bar: 'bad',
                  note: '一瓶就把一天游离糖的理想上限顶满；按 WHO 宽松上限 50g 算，也占了八成。' }
        },
        {
          name: '植脂末', flag: 'red', role: '奶味（奶精，不是奶）', what: '葡萄糖浆＋氢化植物油＋少量乳粉＋酪蛋白酸钠做成的「奶精」粉。',
          why: '便宜、香气足、口感滑，奶茶的「浓」主要来自它。',
          caution: '氢化植物油是反式脂肪的主要来源；标签能写「反式脂肪 0g」，是按国标 ≤0.3g/100mL 就能标 0 的口径。'
        },
        { name: '脱脂奶粉', flag: 'green', role: '奶成分', what: '真的奶粉，但量很少。', why: '标签自己写了：进口乳粉添加量 ≥1.0%。' },
        { name: '红茶叶', flag: 'green', role: '茶味', what: '阿萨姆红茶的茶叶。', why: '标签标注添加量 ≥0.5%，茶汤的底子靠它。', caution: '含咖啡因，睡眠浅的人下午以后少喝。' },
        {
          name: '单，双，三甘油脂肪酸酯 / 双乙酰酒石酸单双甘油酯', flag: 'yellow', role: '乳化剂',
          what: '让油和水不分层的乳化剂。', why: '植脂末冲进水里要靠它们才不浮油、不挂壁。',
          caution: '合规添加，正常饮用不用担心。名字长不代表有害。'
        },
        {
          name: '六偏磷酸钠 / 三聚磷酸钠 / 焦磷酸二氢二钠', flag: 'yellow', role: '稳定剂（磷酸盐）',
          what: '几种磷酸盐，防沉淀、保口感。', why: '让奶茶放久了也不分层、不结块。',
          caution: '在国标限量内使用；需要控制磷摄入的人要把它算进去。'
        },
        { name: '碳酸氢钠', flag: 'green', role: '酸度调节', what: '小苏打。', why: '把酸度稳住，喝起来更顺。' },
        { name: 'D-异抗坏血酸钠', flag: 'green', role: '抗氧化', what: '维生素 C 的「表亲」，防氧化变色。', why: '让茶色和奶色不那么快变暗。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的奶香和茶香。', why: '奶粉只有 1%，香气得靠它补足。', caution: '「奶香浓」不等于奶多，这条对奶茶饮料最适用。' }
      ],
      nutrition: [
        { name: '能量', per100: '230 kJ', whole: '1150 kJ ≈ 275 kcal', nrv: 14, cm: '一瓶约等于一碗米饭（250g 熟饭）。' },
        { name: '碳水化合物', per100: '9.2 g', whole: '46 g', nrv: 15, cm: '按配料推算，几乎全是糖。' },
        { name: '其中糖（推算）', per100: '≈ 8 g', whole: '≈ 40 g', nrv: 0, cm: '标签没有单列「糖」——国标只在有相关宣称时才强制标。按配料排序看：白砂糖第二位，植脂末里还有葡萄糖浆。', hi: true },
        { name: '蛋白质', per100: '0.6 g', whole: '3.0 g', nrv: 5, cm: '纯牛奶 ≥2.9g/100mL，它是五分之一；连 GB/T 21732 含乳饮料要求的 1.0g/100mL 都没到。' },
        { name: '脂肪', per100: '1.7 g', whole: '8.5 g', nrv: 14, cm: '主要来自植脂末里的植物油和奶粉。' },
        { name: '钠', per100: '50 mg', whole: '250 mg', nrv: 13, cm: '来自磷酸盐和原料，当天还要算上别的。' },
        { name: '反式脂肪', per100: '0 g（标称）', whole: '0 g（标称）', nrv: 0, cm: '国标门槛：低于 0.3g/100mL 就能写 0。配料里植脂末含氢化植物油，标 0 不等于完全没有。' }
      ],
      equiv: [
        { big: '≈ 10 块', small: '方糖（4g／块）' },
        { big: '≈ 40 分钟', small: '慢跑消耗掉这瓶' },
        { big: '1/5', small: '纯牛奶的蛋白质含量' }
      ],
      trace: {
        found: false, place: '标签没印厂址，只给制造商代码',
        lines: ['产品标准号 GB/T 21733（茶饮料），不是含乳饮料的 GB/T 21732',
                '阿萨姆红茶茶叶添加量 ≥0.5%，进口乳粉添加量 ≥1.0%',
                '同款在不同区域由分厂灌装，制造商代码印在瓶身或瓶盖'],
        source: '包装标签，核对时间 2026-11-22',
        note: '产地不编：标签只给到制造商代码，具体工厂以瓶身喷码为准。'
      },
      tricks: [
        {
          claim: '「奶茶」两个字', ok: false,
          truth: '奶的部分主要是植脂末（葡萄糖浆＋氢化植物油＋少量乳粉），真奶粉标签自己写了 ≥1.0%，红茶茶叶 ≥0.5%。香、滑、浓，靠的是配比、香精和增稠，不是奶多。',
          basis: '蛋白质 <b>0.6 g/100mL</b>；纯牛奶 ≥2.9，GB/T 21732 含乳饮料 ≥1.0；执行标准是 <b>GB/T 21733</b>（茶饮料）'
        },
        {
          claim: '「反式脂肪 0 g」', ok: false,
          truth: '按 GB 28050，反式脂肪 ≤0.3g/100mL 就可以标 0。配料里有植脂末（含氢化植物油），标 0 是「低于标示门槛」，不是「完全不含」。',
          basis: '国标把 <b>0.3 g/100mL</b> 定为可以标「0」的门槛'
        },
        {
          claim: '「0 蔗糖」那一类乳茶', edu: true,
          truth: '这瓶没打「0 蔗糖」，糖是明明白白的。真正容易踩坑的是货架上写「0 蔗糖」的乳茶：没加蔗糖，却加了结晶果糖、果葡糖浆或代糖，糖照样有。2021 年元气森林乳茶就因为「0 蔗糖≠0 糖」的标注被公开质疑，发了致歉公告、把包装改成「低糖」。',
          basis: '判定只看一处：营养成分表的 <b>碳水化合物 / 糖</b>，不看包装正面的大字'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'risk', text: '整瓶 46g 碳水、基本是糖，升糖快，不建议喝。' },
        { tag: '减脂', level: 'risk', text: '275 kcal 液体热量还不顶饱，最容易变成「白喝一碗饭」。' },
        { tag: '想补钙 / 补蛋白', level: 'risk', text: '蛋白质只有 3g，同样 500mL 纯牛奶有 16g，别拿它当奶喝。' },
        { tag: '乳糖不耐', level: 'tip', text: '含脱脂奶粉，但添加量只有 1% 上下，多数人不至于难受；真敏感还是换无乳的。' },
        { tag: '睡眠浅 / 咖啡因敏感', level: 'tip', text: '含红茶，有咖啡因，下午晚些时候别喝。' },
        { tag: '给孩子买', level: 'risk', text: '甜度高、香精重，容易把口味养甜；真想给就倒小半杯。' }
      ],
      pairs: [
        { with: '正餐', why: '一餐里再配甜饮料，糖很容易超；真想喝就放到两餐之间，当餐主食减一点。' },
        { with: '其他甜饮料（同日）', why: '一瓶已顶满一天的游离糖理想上限，再来一瓶直接翻倍。' },
        { with: '空腹', why: '空腹喝含糖饮料升糖更快，也更容易饿。' }
      ],
      buzz: {
        flavor: ['奶香浓，但主要来自植脂末和香精', '甜度高，茶味偏淡', '口感顺滑不涩，冰镇后更明显'],
        topics: [
          { t: '奶茶饮料到底有没有奶', d: '有，但很少：标签写进口乳粉添加量 ≥1.0%，蛋白质 0.6g/100mL，不到纯牛奶的四分之一。' },
          { t: '一瓶到底多少糖', d: '标签不单列糖，按碳水 9.2g/100mL 算，整瓶 46g，约 10 块方糖。' }
        ]
      },
      compare: {
        metric: '蛋白质 g / 100mL',
        rows: [
          { name: '纯牛奶', value: 3.2 }, { name: '调制乳下限', value: 2.3 },
          { name: '含乳饮料下限', value: 1.0 }, { name: '阿萨姆奶茶', value: 0.6, me: true }, { name: '可乐', value: 0 }
        ]
      },
      ocrText: '配料表：水、白砂糖、植脂末（葡萄糖浆、氢化植物油、乳粉、酪蛋白酸钠、单，双，三甘油脂肪酸酯、双乙酰酒石酸单双甘油酯、磷酸氢二钾、柠檬酸钠、六偏磷酸钠、二氧化硅）、脱脂奶粉、红茶叶、食品添加剂（食用香精、单，双甘油硬脂酸酯、焦磷酸二氢二钠、三聚磷酸钠、碳酸氢钠、D-异抗坏血酸钠） 产品标准号：GB/T 21733 致敏原信息：含乳制品 生产商：统一企业（中国）投资有限公司',
      lowConf: ['单，双甘油脂肪酸酯', '双乙酰酒石酸单双甘油酯']
    },
    '6921168550142': {
      id: 'weitaming',
      name: '力量帝 维他命水 柑橘风味',
      brand: '农夫山泉',
      spec: '500 ml / 瓶',
      volume: 500,
      barcode: '6921168550142',
      category: '营养素饮料',
      verdict: { level: 'caution', label: '适量更合适', why: '维生素 C 100mg 是真到账的，但得用 26g 糖换——比可乐强，离「健康饮品」还差一截。' },
      keys: [
        { l: '维生素 C', v: '100', u: 'mg / 瓶', hi: true },
        { l: '糖（推算）', v: '≈ 26', u: 'g / 瓶', hi: true },
        { l: '能量', v: '148', u: 'kcal / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '配料第一位，占这瓶的大头。' },
        {
          name: '白砂糖', flag: 'red', role: '甜味（糖的主要来源）', what: '最常见的添加糖，蔗糖。',
          why: '排第二位，橙味饮料的甜度主要靠它。',
          caution: '标签没有单列「糖」，按碳水 28.5g／瓶推算，糖约 26g。',
          dose: { amount: '≈ 26 g', limit: '游离糖建议 < 25 g/天（WHO 理想值）', pct: 100, bar: 'warn',
                  note: '一瓶已经顶满一天游离糖的理想上限；按宽松上限 50g 算也占了一半。' }
        },
        { name: '果葡糖浆', flag: 'yellow', role: '甜味', what: '玉米淀粉做的糖浆，一半是果糖。', why: '和白砂糖叠加，甜度上去、成本下来。', caution: '果糖不走「饱腹」那条路，喝了不容易觉得够，容易一路喝下去。' },
        {
          name: '浓缩橙汁', flag: 'green', role: '真果汁（不是香精）', what: '橙子浓缩汁还原的果汁。',
          why: '这瓶的橙味有真果汁打底，不是纯香精调出来的。',
          caution: '排在糖后面，说明添加量不大；具体比例标签没标。'
        },
        { name: '柠檬酸', flag: 'green', role: '酸度调节', what: '柑橘里本来就有的有机酸。', why: '把甜压一压，喝起来不那么腻。' },
        {
          name: 'β-胡萝卜素', flag: 'yellow', role: '着色（顺带给点维生素 A 前体）', what: '胡萝卜里的橙黄色素。',
          why: '这瓶的橙色主要是它调的，不是橙汁的颜色。',
          caution: '它是食用色素，标识「天然」也不等于营养强化，别按补维生素 A 来算。'
        },
        { name: 'D-异抗坏血酸钠', flag: 'green', role: '抗氧化', what: '维生素 C 的「表亲」，防止变色变味。', why: '让橙色和风味别那么快走样。' },
        { name: '柠檬酸钾', flag: 'green', role: '酸度调节 / 钾源', what: '柠檬酸的钾盐。', why: '稳住酸度，同时补一点钾。' },
        {
          name: 'L-乳酸钙', flag: 'green', role: '钙强化', what: '一种吸收率不错的钙盐。',
          why: '标签上「钙 119mg／瓶」就是它带来的。',
          dose: { amount: '119 mg', limit: '每日推荐 800 mg', pct: 15, bar: 'good',
                  note: '一瓶给到每日钙的 15%，一杯牛奶（250mL）约 260mg，比它多一倍。' }
        },
        {
          name: '维生素 C', flag: 'green', role: '营养强化（这瓶的主角）', what: '抗坏血酸，人体自己造不出来，得靠吃。',
          why: '标签标 100mg／瓶，正好是每日推荐量的 100%，这一项标得实在。',
          dose: { amount: '100 mg', limit: '每日推荐 100 mg', pct: 100, bar: 'good',
                  note: '补维 C 是真的；但一个中等橙子约 50mg 维 C，还没有这 26g 糖。' }
        },
        { name: '硫酸镁', flag: 'green', role: '镁强化', what: '补镁用的镁盐。', why: '出汗多的时候镁会跟着流失，饮料里常见。' },
        { name: '维生素 E / 烟酰胺 / 维生素 B6', flag: 'green', role: '营养强化', what: '脂溶性维生素 E、B 族里的烟酰胺（B3）和 B6。', why: '标签分别标了 5.0mg、5.26mg、0.56mg，都是每日参考值的 35–40%。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '补足橙香的香精。', why: '真果汁量有限，香气得靠它补齐。', caution: '「果味」两个字不等于果汁含量高。' }
      ],
      nutrition: [
        { name: '能量', per100: '124 kJ', whole: '620 kJ ≈ 148 kcal', nrv: 7, cm: '一瓶约等于半碗多米饭。' },
        { name: '碳水化合物', per100: '5.7 g', whole: '28.5 g', nrv: 10, cm: '按配料推算，绝大部分是糖。' },
        { name: '其中糖（推算）', per100: '≈ 5.2 g', whole: '≈ 26 g', nrv: 0, cm: '标签没有单列「糖」——国标只在有相关宣称时才强制标。白砂糖排第二、果葡糖浆排第三。', hi: true },
        { name: '维生素 C', per100: '20 mg', whole: '100 mg', nrv: 100, cm: '正好是每日推荐量，这一项是真强化，不是话术。' },
        { name: '维生素 E', per100: '1.0 mg', whole: '5.0 mg', nrv: 36, cm: '标签标 5.00mg α-生育酚当量。' },
        { name: '烟酰胺（B3）', per100: '1.05 mg', whole: '5.26 mg', nrv: 35, cm: 'B 族之一，日常饮食一般不缺。' },
        { name: '维生素 B6', per100: '0.11 mg', whole: '0.56 mg', nrv: 40, cm: '同上。' },
        { name: '钙', per100: '23.8 mg', whole: '119 mg', nrv: 15, cm: '来自 L-乳酸钙；一杯牛奶约 260mg，比它多一倍。' },
        { name: '蛋白质 / 脂肪', per100: '0 g', whole: '0 g', nrv: 0, cm: '都没有。' }
      ],
      equiv: [
        { big: '100%', small: '每日维生素 C' },
        { big: '≈ 7 块', small: '方糖（4g／块）' },
        { big: '≈ 21 分钟', small: '慢跑消耗掉这瓶' }
      ],
      trace: {
        found: false, place: '标签标「农夫山泉股份有限公司」，具体灌装厂见瓶身喷码',
        lines: ['生产商：农夫山泉股份有限公司（浙江省杭州市）',
                '同款由多地工厂灌装，厂名厂址以瓶身 / 瓶盖喷码为准',
                '浓缩橙汁未标添加量，标签只按顺序体现多少'],
        source: '包装标签（柑橘风味 500ml），核对时间 2026-11-22',
        note: '产地不编：标签只给到公司名，具体工厂以喷码为准。'
      },
      tricks: [
        {
          claim: '「补充维生素 C」', ok: true,
          truth: '维生素 C 100mg／瓶确实是每日推荐量的 100%，这一项标得实在，不是文字游戏。但要连着 26g 糖一起喝下去——补维 C 最划算的方式仍然是吃水果。',
          basis: '标签每份（500mL）：维生素 C <b>100 mg</b>（NRV 100%）、碳水化合物 <b>28.5 g</b>'
        },
        {
          claim: '「果味饮料」里有橙汁吗', ok: false, edu: true,
          truth: '有，浓缩橙汁排在糖后面，量不大；这瓶的橙色主要来自 β-胡萝卜素，橙香还有食用香精补齐。配料顺序就是含量顺序，看顺序比看正面「橙」字靠谱。',
          basis: 'GB 7718：配料按加入量<b>递减排列</b>；本品顺序为水、白砂糖、果葡糖浆、浓缩橙汁……'
        },
        {
          claim: '「营养素饮料」≠「保健食品」', ok: false, edu: true,
          truth: '它是普通食品（营养素饮料），不是带「蓝帽子」的保健食品，不能宣称任何功效。标签上的维生素数字是真的，但「喝了有劲」这类说法没有依据。',
          basis: '保健食品需有专用标志与批准文号；本品标签上没有'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'risk', text: '26g 糖／瓶，升糖快，不建议当日常饮品。' },
        { tag: '减脂', level: 'risk', text: '148 kcal 液体热量，不顶饱，容易白喝。' },
        { tag: '运动后 / 大量出汗', level: 'tip', text: '补糖、补钾镁钙的场景是对的，比纯水强；但普通上班日不需要。' },
        { tag: '想靠它补维 C', level: 'tip', text: '100mg 确实够一天；一个橙子约 50mg 维 C，还有纤维，更划算。' },
        { tag: '给孩子买', level: 'tip', text: '比可乐好一点，但仍是甜饮料；别让它替代水果和牛奶。' },
        { tag: '咖啡因敏感', level: 'tip', text: '这瓶不含咖啡因，睡前喝不影响睡眠（但糖会影响）。' }
      ],
      pairs: [
        { with: '正餐', why: '甜饮料占胃口，饭吃得少、糖却吃得多；要喝就放两餐之间。' },
        { with: '运动后 30 分钟内', why: '这时候补糖补电解质是合理的，吸收也快。' },
        { with: '其他甜饮料（同日）', why: '一瓶已是理想上限，再叠加就翻倍。' }
      ],
      buzz: {
        flavor: ['橙味偏甜，酸感比脉动弱', '有轻微的 B 族维生素味', '无气泡，喝完口中略黏'],
        topics: [
          { t: '维他命水到底补不补维 C', d: '柑橘风味标 100mg／瓶，是每日推荐量的 100%，确实到账；争议一直在糖——26g／瓶。' },
          { t: '和脉动怎么选', d: '结构很像：水＋糖＋酸＋维生素。脉动糖 34.8g／瓶，这瓶 26g；看营养成分表两栏就够。' }
        ]
      },
      compare: {
        metric: '糖 g / 100mL（推算）',
        rows: [
          { name: '可乐', value: 10.6 }, { name: '阿萨姆奶茶', value: 8.0 },
          { name: '脉动', value: 5.8 }, { name: '维他命水', value: 5.2, me: true }, { name: '元气森林气泡水', value: 0 }
        ]
      },
      ocrText: '配料表：水、白砂糖、果葡糖浆、浓缩橙汁、柠檬酸、β-胡萝卜素、D-异抗坏血酸钠、柠檬酸钾、L-乳酸钙、维生素C、硫酸镁、维生素E、烟酰胺、维生素B6、食用香精 产品类型：营养素饮料 净含量：500ml 生产商：农夫山泉股份有限公司 厂址：浙江省杭州市',
      lowConf: ['D-异抗坏血酸钠', '烟酰胺']
    }
  };

  var LIST = Object.keys(PRODUCTS).map(function (k) { return PRODUCTS[k]; });

  // 这一份是「示例数据」，不是条码库：名字、条码都是演示用的。
  // 打上 demoOnly 之后，扫码链路一律不吃它——扫到什么码，身份只能来自后端条码库，
  // 免得示例改版后「扫 A 出 B」。
  LIST.forEach(function (p) { p.demoOnly = true; });

  // 手输条码 / 相机识别：未收录的条码返回 null，前端改走配料表路径
  function lookup(code) {
    return PRODUCTS[String(code).trim()] || null;
  }

  // 拍配料表（无条码）路径：按识别文本里的关键词匹配到最接近的示例；匹配不上返回 null，走 fromText 兜底
  function matchByText(text) {
    var t = String(text || '');
    var best = null, score = 0;
    LIST.forEach(function (p) {
      var s = 0;
      p.ingredients.forEach(function (i) {
        var key = i.name.replace(/（.*?）/g, '').split('、')[0].slice(0, 3);
        if (key.length >= 2 && t.indexOf(key) !== -1) s += 1;
      });
      if (s > score) { score = s; best = p; }
    });
    return score >= 3 ? best : null;
  }

  // 常见配料的本地小词条：没匹配到整款商品时，至少这几种解释是真的
  var GLOSSARY = {
    '水': { flag: 'green', role: '主体', what: '就是水，排第一位说明它占这份配料的大头。', why: '产品的主要部分。' },
    '白砂糖': { flag: 'yellow', role: '甜味', what: '蔗糖，最常见的添加糖。', why: '提供甜味和能量，属于游离糖。', caution: '看营养成分表「糖」那一栏估算总量。' },
    '果葡糖浆': { flag: 'yellow', role: '甜味', what: '玉米淀粉做的糖浆，一半是果糖，比蔗糖更甜也更便宜。', why: '常与白砂糖叠加使用。', caution: '不走饱腹信号，容易喝多。' },
    '食用香精': { flag: 'yellow', role: '风味', what: '调出来的香气，不等于果汁。', why: '让「水＋糖＋酸」喝起来有水果味。', caution: '风味名字别当成分看。' },
    '柠檬酸': { flag: 'green', role: '酸度调节', what: '柑橘里就有的有机酸。', why: '调酸甜比，略带防腐作用。' },
    '二氧化碳': { flag: 'green', role: '气泡', what: '打进去的气，产生泡沫感。', why: '不提供热量。' },
    '赤藓糖醇': { flag: 'yellow', role: '代糖', what: '糖醇，甜度约蔗糖 65%，热量几乎为零。', why: '大部分原样排出，不参与血糖代谢。', caution: '糖醇的耐受情况因人而异，部分人摄入较多后可能出现肠胃不适。' },
    '三氯蔗糖': { flag: 'yellow', role: '代糖', what: '高倍甜味剂，甜度约蔗糖 600 倍，用量极小。', why: '和别的代糖搭配把甜度补足。', caution: '配料表名称不显示本产品中的实际使用量；相关要求需结合产品类别与适用标准核对。介意人工甜味剂可按偏好选择。' },
    '卡拉胶': { flag: 'yellow', role: '增稠稳定', what: '海藻提取的多糖。', why: '让口感更厚。', caution: '那是口感，不是营养。' },
    '维生素C': { flag: 'green', role: '营养强化', what: '抗坏血酸。', why: '添加量看营养成分表或标签标注。' },
    '食盐': { flag: 'yellow', role: '调味', what: '氯化钠。', why: '影响当天的总钠摄入。' },
    '苯甲酸钠': { flag: 'yellow', role: '防腐剂', what: '常用防腐剂，酸性环境里才有效。', why: '只在国标规定的最大使用量内使用。' }
  };

  function glossaryFor(name) {
    var local = GLOSSARY[name] || GLOSSARY[name.replace(/（.*?）/g, '')];
    if (local) return local;
    var entry = w.INGREDIENT_GLOSSARY && w.INGREDIENT_GLOSSARY.lookup(name);
    if (!entry) return null;
    return {
      flag: 'green', role: entry.role, what: entry.what,
      why: entry.uses ? '常见用途：' + entry.uses + '。' : '', caution: ''
    };
  }

  function norm(s) { return s.trim().replace(/^其中[:：]?/, ''); }

  // 兜底：条码与文本都没命中时，仍然把「逐项拆开看」这个动作做完，不编造结论
  function fromText(text) {
    var items = String(text || '')
      .replace(/配料表[:：]?/g, '')
      .split(/[、,，;；\n]/)
      .map(norm)
      .filter(function (s) { return s.length >= 1; });
    var known = 0;
    var ing = items.map(function (name) {
      var g = glossaryFor(name);
      if (g) { known++; return { name: name, flag: g.flag, role: g.role, what: g.what, why: g.why, caution: g.caution || '' }; }
      return {
        name: name, flag: 'yellow', role: '待解读',
        what: '演示库没有这一项的词条。',
        why: '接后端后由大模型结合 GB 2760 给出：是什么、起什么作用、要注意什么。',
        caution: ''
      };
    });
    return {
      id: 'unknown',
      name: '未收录商品（按配料表文本解读）',
      brand: '演示库外',
      spec: items.length + ' 项配料',
      volume: 0,
      barcode: '未采集',
      category: '按文本兜底解析',
      verdict: {
        level: 'caution', label: '需人工确认',
        why: '条码和文本都没在演示库命中，这页只把配料逐项拆开，不下购买结论，不编数据。'
      },
      keys: [
        { l: '识别到', v: String(items.length), u: '项配料' },
        { l: '有词条', v: String(known), u: '项', hi: known < items.length },
        { l: '结论', v: '暂不下', u: '不猜' }
      ],
      ingredients: ing,
      ingNote: '本地词条由团队表格经 AI 复核整理，只解释名称与常见用途；不据此判断合法用量或个体健康风险，未命中项不猜。',
      nutrition: [],
      equiv: [],
      trace: {
        found: false,
        place: '未匹配到商品档案',
        lines: ['演示库只收录了 ' + LIST.length + ' 款示例商品，这款没有对应记录', '接后端后：文本送大模型逐项解读 + GB 2760 添加剂校验 + 联网溯源'],
        source: '本地演示库，2026-11-21',
        note: '取不到依据时只展示能确定的部分，产地与用量结论一律留空。'
      },
      tricks: [],
      health: [],
      pairs: [],
      buzz: null,
      compare: { metric: '配料项数（示例库内对比需后端）', rows: [{ name: '本次识别', value: items.length || 1, me: true }] },
      ocrText: String(text || ''),
      lowConf: []
    };
  }

  w.DEMO = { products: PRODUCTS, list: LIST, lookup: lookup, matchByText: matchByText, fromText: fromText };
})(window);
