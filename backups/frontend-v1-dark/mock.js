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
      verdict: { level: 'caution', label: '可以喝', why: '维生素是真的，但一瓶 35g 糖也是真的，别把它当水喝。' },
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
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的水蜜桃香味，不是果汁。', why: '让「水 + 糖 + 酸」喝起来像水果味。', caution: '配料表里没有水蜜桃，甜香靠它。合规添加，但别以为在喝果汁。' },
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
          { name: '维他命水', value: 8.0 }, { name: '尖叫', value: 6.0 }, { name: '东方树叶', value: 0 }
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
      verdict: { level: 'good', label: '可以喝', why: '「0 糖 0 脂 0 卡」的标注有国标依据，甜味来自代糖。喝多了可能胀气。' },
      keys: [
        { l: '糖', v: '0', u: 'g / 瓶' },
        { l: '能量', v: '0', u: 'kJ / 瓶' },
        { l: '赤藓糖醇', v: '≈ 24', u: 'g / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '气泡水的基底。' },
        { name: '二氧化碳', flag: 'green', role: '气泡', what: '打进去的气，产生「杀口」的泡沫感。', why: '不提供任何热量。' },
        {
          name: '赤藓糖醇', flag: 'yellow', role: '代糖（甜味主体）', what: '一种糖醇，甜度约为蔗糖的 65%，热量几乎为零。',
          why: '它大部分随尿原样排出，不参与血糖代谢，所以能标「0 卡」。',
          caution: '一次摄入较多（约 30–35g 以上）容易腹胀、肠鸣、腹泻，空腹喝更明显。',
          dose: { amount: '≈ 24 g', limit: '国标未设上限；耐受阈值参考 30–35 g/次', pct: 72, bar: 'warn',
                  note: '一瓶约到耐受阈值的 72%。多数人一次一瓶没事，但一口气两瓶就可能不舒服。' }
        },
        { name: '三氯蔗糖', flag: 'yellow', role: '代糖（补甜）', what: '高倍甜味剂，甜度约蔗糖 600 倍，用量极小。', why: '和赤藓糖醇搭配，把甜度补足、口感做得更接近真糖。', caution: '合规添加，安全性评价充分；介意人工甜味剂的人可以避开。' },
        { name: '乳酸', flag: 'green', role: '酸度调节', what: '发酵常见的有机酸，提供柔和的酸。', why: '平衡甜味，让口感不发腻。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的白桃香。', why: '配料里没有白桃果汁。', caution: '「白桃味」= 香精味，不是桃子味。' },
        { name: '碳酸氢钠', flag: 'green', role: '酸度调节', what: '小苏打。', why: '调节酸碱度，稳定气泡。' }
      ],
      nutrition: [
        { name: '能量', per100: '0 kJ', whole: '0 kJ', nrv: 0, cm: '按 GB 28050，≤17kJ/100mL 即可标「0 能量」。' },
        { name: '蛋白质', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '脂肪', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '碳水化合物', per100: '0 g', whole: '0 g', nrv: 0, cm: '赤藓糖醇按国标可不计入碳水化合物总量。' },
        { name: '钠', per100: '24 mg', whole: '115 mg', nrv: 6, cm: '来自碳酸氢钠和原料，量不大。' }
      ],
      equiv: [
        { big: '0 块', small: '方糖当量' },
        { big: '≈ 24 g', small: '赤藓糖醇／瓶' },
        { big: '72%', small: '单次耐受阈值参考' }
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
          truth: '这一款标注是站得住的：没有添加糖，能量为 0，符合国标的「0 能量」标注条件。甜味来自赤藓糖醇和三氯蔗糖。',
          basis: 'GB 28050 定的门槛是能量 ≤ <b>17 kJ/100mL</b>、糖 ≤ <b>0.5 g/100mL</b>，这瓶两项都在线内'
        },
        {
          claim: '「0 蔗糖」≠「0 糖」', edu: true,
          truth: '这是整个品类最该记住的一条：只写「0 蔗糖」时，可能加了果糖、葡萄糖、麦芽糖浆，照样是糖。2021 年该品牌「0 蔗糖」乳茶争议就是这个坑。买的时候看营养成分表的「糖」那一栏，别看正面大字。',
          basis: '判定只看一处：营养成分表 <b>糖 g/100mL</b>，不是包装正面的宣称'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'tip', text: '不含糖、不升血糖，是这类人群相对可选的甜饮料。' },
        { tag: '减脂', level: 'tip', text: '0 能量，替代含糖饮料是划算的。注意别因为它「0 卡」就一天喝好几瓶。' },
        { tag: '肠胃敏感 / IBS', level: 'risk', text: '糖醇类容易胀气、腹泻，空腹或一次两瓶更明显。建议减半或换纯水气泡。' },
        { tag: '儿童', level: 'tip', text: '偶尔喝没问题，但别让它养成对甜味的依赖。' }
      ],
      pairs: [
        { with: '高脂正餐', why: '气泡＋冷饮容易加重饱胀感，肠胃敏感的人会更明显。' },
        { with: '一口气多瓶', why: '糖醇耐受按次算，一瓶约到参考阈值的 72%，连续两瓶腹胀腹泻的概率明显上升。' }
      ],
      buzz: {
        flavor: ['白桃香（香精调味）', '甜度高，代糖后味有人敏感', '气泡足，冷藏后更「杀口」'],
        topics: [
          { t: '赤藓糖醇会不会拉肚子', d: '讨论最多的是糖醇耐受：一次喝多容易腹胀肠鸣，肠胃敏感的人评价两极。' },
          { t: '「0 糖 0 卡」是不是文字游戏', d: '这一款标注有国标依据；真正容易混淆的是同品牌乳茶的「0 蔗糖」，两个概念别混。' }
        ]
      },
      compare: {
        metric: '含糖量 g / 100mL',
        rows: [
          { name: '可乐', value: 10.6 }, { name: '脉动', value: 5.8 },
          { name: '维他命水', value: 8.0 }, { name: '元气森林气泡水', value: 0, me: true }, { name: '东方树叶', value: 0 }
        ]
      },
      ocrText: '配料表：水、二氧化碳、赤藓糖醇、乳酸、食用香精、三氯蔗糖、碳酸氢钠 产品标准号：GB/T 10792 生产商：元气森林（北京）食品科技集团有限公司 厂址：北京市朝阳区酒仙桥',
      lowConf: ['三氯蔗糖', '碳酸氢钠']
    },

    '6902510000134': {
      id: 'milktea',
      name: '某品牌 0 蔗糖乳茶',
      brand: '某品牌（示例）',
      spec: '500 ml / 瓶',
      volume: 500,
      barcode: '6902510000134',
      category: '调制乳 / 乳饮料',
      verdict: { level: 'bad', label: '建议别买', why: '「0 蔗糖」只是把糖换了个名字，一瓶 37.5g 糖，蛋白质只有牛奶的三分之一。' },
      keys: [
        { l: '糖', v: '37.5', u: 'g / 瓶', hi: true },
        { l: '能量', v: '300', u: 'kcal / 瓶', hi: true },
        { l: '蛋白质', v: '5.0', u: 'g / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '排在第一位。', why: '这瓶的一半以上是水，不是奶。' },
        {
          name: '生牛乳', flag: 'green', role: '奶味与蛋白', what: '真正的牛奶，不是奶粉冲调。',
          why: '提供奶味和一部分蛋白质。', caution: '乳糖不耐的人喝了可能腹胀腹泻。',
          dose: { amount: '约 150 mL', limit: '不用限量', pct: 0, bar: 'good', note: '按蛋白质 1.0g/100mL 反推，奶的比例不算高。' }
        },
        {
          name: '结晶果糖', flag: 'red', role: '甜味（这就是「0 蔗糖」的秘密）', what: '从水果／玉米淀粉提取的糖，甜度比蔗糖高，代谢路径不同。',
          why: '替代蔗糖提供甜味，让包装可以写「0 蔗糖」。',
          caution: '它照样是游离糖。果糖不刺激胰岛素、不走饱腹信号，但过量会加重肝脏负担、升高尿酸和血脂。',
          dose: { amount: '25 g', limit: '游离糖建议 < 25 g/天（WHO 理想值）', pct: 100, bar: 'bad',
                  note: '仅这一项就顶满一天的理想上限。加上赤藓糖醇前的其他糖，整瓶 37.5g。' }
        },
        { name: '赤藓糖醇', flag: 'yellow', role: '代糖', what: '低热量糖醇，和结晶果糖搭配把甜度做高。', why: '让「0 蔗糖」喝起来比真糖还甜。', caution: '一次摄入较多容易腹胀。' },
        { name: '全脂乳粉', flag: 'green', role: '奶味', what: '奶粉，补充奶香和固体含量。', why: '和生牛乳一起构成「乳」的部分。' },
        { name: '单，双甘油脂肪酸酯', flag: 'yellow', role: '乳化剂', what: '让脂肪和水不分层的乳化剂。', why: '防止「上面一层油、下面一层水」。', caution: '合规添加，正常饮用无需担心。名字长不代表有害。' },
        { name: '卡拉胶', flag: 'yellow', role: '增稠稳定', what: '从海藻提取的多糖，做增稠。', why: '让口感更厚、更像奶茶。', caution: '让稀的液体喝起来像浓的，这是口感，不是营养。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的奶茶香。', why: '补足奶味和茶味的感知。' },
        { name: '三氯蔗糖', flag: 'yellow', role: '代糖', what: '高倍甜味剂。', why: '和果糖、糖醇叠加拉高甜度。' }
      ],
      nutrition: [
        { name: '能量', per100: '250 kJ', whole: '1250 kJ ≈ 300 kcal', nrv: 15, cm: '一瓶约等于一碗半米饭。' },
        { name: '碳水化合物', per100: '8.0 g', whole: '40 g', nrv: 13, cm: '其中糖 7.5g/100mL，几乎全是糖。' },
        { name: '其中糖（推算）', per100: '7.5 g', whole: '37.5 g', nrv: 0, cm: '「0 蔗糖」的瓶子里，糖是 37.5g。', hi: true },
        { name: '蛋白质', per100: '1.0 g', whole: '5.0 g', nrv: 8, cm: '只有纯牛奶（≥2.9g/100mL）的三分之一。' },
        { name: '脂肪', per100: '1.6 g', whole: '8.0 g', nrv: 3, cm: '来自牛奶和乳粉。' },
        { name: '钠', per100: '60 mg', whole: '300 mg', nrv: 15, cm: '比前两瓶都高，注意当天总盐。' }
      ],
      equiv: [
        { big: '≈ 10 块', small: '方糖（4g／块）' },
        { big: '≈ 45 分钟', small: '慢跑消耗掉这瓶' },
        { big: '1/3', small: '纯牛奶的蛋白质含量' }
      ],
      trace: {
        found: false, place: '官网未查到该产品原料产地公示',
        lines: ['品牌官网未提供按批次的原料溯源页', '包装标注：生产商 ×× 食品（委托加工），产地见喷码'],
        source: '联网搜索 2026-11-21：官网无相关数据',
        note: '溯源数据缺失，本次结论只基于配料表与营养成分表逐项说明，不涉及产地判断。'
      },
      tricks: [
        {
          claim: '「0 蔗糖」', ok: false,
          truth: '它没加蔗糖，但加了结晶果糖 25g／瓶，照样是糖，而且比蔗糖更不容易让人觉得饱。整瓶含糖 37.5g，属于高糖饮料。',
          basis: 'GB 28050 的「无糖」门槛是 ≤ <b>0.5 g/100mL</b>，这瓶是 <b>7.5 g/100mL</b>，为门槛的 15 倍'
        },
        {
          claim: '「健康／轻负担」', ok: false,
          truth: '一瓶 300kcal、40g 碳水、300mg 钠，「轻」主要体现在文案上。',
          basis: '一瓶 <b>300 kcal</b>，接近一碗米饭；热量密度 250 kJ/100mL 与纯牛奶（约 270 kJ）相当，蛋白质却只有三分之一'
        },
        {
          claim: '「含生牛乳」', ok: true,
          truth: '确实加了真牛奶，不是纯奶粉勾兑，这一点标注属实。但蛋白质只有 1.0g/100mL，说明奶的比例不高。',
          basis: '纯牛奶蛋白质 ≥ <b>2.9 g/100mL</b>；调制乳 ≥ <b>2.3 g/100mL</b>（GB 25191）'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'risk', text: '果糖虽不直接升血糖，但会转化为脂肪、影响胰岛素敏感性。这类「0 蔗糖」饮料对控糖人群是陷阱，建议不选。' },
        { tag: '减脂', level: 'risk', text: '300kcal 液体热量 + 低蛋白，不顶饱，最容易变成「白喝」。' },
        { tag: '高尿酸 / 痛风', level: 'risk', text: '果糖代谢会升高尿酸生成，急性期尤其要避开。' },
        { tag: '乳糖不耐', level: 'risk', text: '含生牛乳和乳粉，有乳糖，可能腹胀腹泻。' },
        { tag: '给孩子买', level: 'risk', text: '高糖 + 香精 + 增稠剂，不建议作为日常饮品。真想喝就分小半杯。' },
        { tag: '孕期', level: 'risk', text: '糖分和钠都偏高，偶尔小口喝问题不大，不建议常喝。' }
      ],
      pairs: [
        { with: '正餐', why: '一餐的糖和热量容易一起超标；真想喝就放到两餐之间，并把当餐主食减一点。' },
        { with: '其他甜饮料（同日）', why: '一瓶已经顶满一天游离糖理想上限，再来一瓶直接翻倍。' },
        { with: '尿酸偏高时的酒精', why: '果糖和酒精都会推高尿酸，两个叠加对痛风人群是双重刺激，建议都避开。' }
      ],
      buzz: {
        flavor: ['奶香偏淡，茶感弱', '甜度高，主要来自结晶果糖', '口感浓稠来自增稠，不等于奶多'],
        topics: [
          { t: '「0 蔗糖」乳茶争议', d: '2021 年同类产品的公开争议就集中在这一点：0 蔗糖≠0 糖。看营养成分表的糖，不看正面大字。' },
          { t: '乳茶和牛奶哪个划算', d: '蛋白质只有纯牛奶的三分之一，价格却往往更高——比较时看蛋白质那一栏。' }
        ]
      },
      compare: {
        metric: '蛋白质 g / 100mL',
        rows: [
          { name: '纯牛奶', value: 3.2 }, { name: '酸奶', value: 2.5 },
          { name: '调制乳下限', value: 2.3 }, { name: '这瓶乳茶', value: 1.0, me: true }, { name: '含乳饮料', value: 1.0 }
        ]
      },
      ocrText: '配料表：水、生牛乳、结晶果糖、赤藓糖醇、全脂乳粉、单，双甘油脂肪酸酯、卡拉胶、食用香精、三氯蔗糖 产品标准号：GB 7101 生产商：某食品有限公司 厂址：安徽省某市',
      lowConf: ['单，双甘油脂肪酸酯', '卡拉胶']
    },

    '6900000100040': {
      id: 'weitaming',
      name: '维他命水 柠檬味（示例）',
      brand: '维他命水（示例）',
      spec: '500 ml / 瓶',
      volume: 500,
      barcode: '6900000100040',
      category: '营养素饮料',
      verdict: { level: 'caution', label: '可以喝', why: '和脉动是同一个套路：维生素 C 是真的，一瓶 40g 糖也是真的。' },
      keys: [
        { l: '糖', v: '40', u: 'g / 瓶', hi: true },
        { l: '能量', v: '160', u: 'kcal / 瓶' },
        { l: '维生素 C', v: '100', u: 'mg / 瓶' }
      ],
      ingredients: [
        { name: '水', flag: 'green', role: '主体', what: '就是水。', why: '配料第一位，占这瓶的大头。' },
        { name: '白砂糖', flag: 'yellow', role: '甜味', what: '蔗糖，最常见的添加糖。', why: '提供甜味和能量。', caution: '与果葡糖浆合计 40g／瓶。' },
        { name: '果葡糖浆', flag: 'yellow', role: '甜味', what: '玉米淀粉做的糖浆，一半是果糖。', why: '和白砂糖叠加，糖总量跟着上去。', caution: '果糖不走饱腹信号，容易喝多。' },
        { name: '柠檬酸', flag: 'green', role: '酸度调节', what: '让口感更清爽的有机酸。', why: '柠檬味的主要来源之一。' },
        {
          name: '维生素 C', flag: 'green', role: '营养强化', what: '抗坏血酸，人体自己造不出来，得靠吃。',
          why: '一瓶 100mg，正好到每日推荐量。',
          dose: { amount: '100 mg', limit: '每日推荐 100 mg', pct: 100, bar: 'good',
                  note: '补维 C 是真的，但为它喝下 40g 糖不划算，吃个橙子更值。' }
        },
        { name: '烟酰胺（维生素 B3）', flag: 'green', role: '营养强化', what: 'B 族维生素的一种。', why: '日常饮食就够，不用为它买单。' },
        { name: '食用香精', flag: 'yellow', role: '风味', what: '调出来的柠檬香，不是柠檬汁。', why: '配料表里没有柠檬果肉。', caution: '风味名字别当成分看。' },
        { name: '柠檬酸钠', flag: 'green', role: '酸度调节', what: '柠檬酸的钠盐，缓冲酸味。', why: '让酸不那么「刺」。' }
      ],
      nutrition: [
        { name: '能量', per100: '134 kJ', whole: '670 kJ ≈ 160 kcal', nrv: 8, cm: '一瓶约等于半碗多米饭。' },
        { name: '碳水化合物', per100: '8.0 g', whole: '40 g', nrv: 13, cm: '基本全是糖。' },
        { name: '钠', per100: '20 mg', whole: '100 mg', nrv: 5, cm: '量不大。' },
        { name: '蛋白质', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' },
        { name: '脂肪', per100: '0 g', whole: '0 g', nrv: 0, cm: '没有。' }
      ],
      equiv: [
        { big: '≈ 10 块', small: '方糖（4g／块）' },
        { big: '≈ 26 分钟', small: '慢跑消耗掉这瓶' },
        { big: '100%', small: '每日维 C 推荐量' }
      ],
      trace: {
        found: false, place: '演示库未收录这款的产地公示',
        lines: ['这款是为「同配料关联」补的示例商品，没有联网溯源档案', '批次与产地以包装喷码为准'],
        source: '本地演示库，2026-11-21',
        note: '没有溯源数据就留空，不编产地。'
      },
      tricks: [
        {
          claim: '「含维生素 C」', ok: false,
          truth: '维 C 加到每日推荐量的 100% 是真的，但同一瓶里还有 40g 糖。「有营养」和「糖多」可以同时成立，别被前半句带走。',
          basis: '每 100mL 含糖 8.0g × 500mL = <b>40g</b>，是 WHO 游离糖理想上限 25g 的 <b>1.6 倍</b>'
        }
      ],
      health: [
        { tag: '控糖 / 糖尿病', level: 'risk', text: '40g 游离糖，升糖快，建议不选。' },
        { tag: '减脂', level: 'risk', text: '160kcal 液体热量，不顶饱。' },
        { tag: '高强度运动后', level: 'tip', text: '大量出汗后补糖补钠合理，这时候喝合适。' }
      ],
      pairs: [
        { with: '其他甜饮料（同日）', why: '一瓶已是理想上限的 1.6 倍，再叠加直接翻倍。' }
      ],
      buzz: {
        flavor: ['柠檬香（香精调味）', '甜度高，酸感比脉动明显', '无气泡'],
        topics: [
          { t: '维他命水和脉动有什么区别', d: '配料结构高度相似：水＋两种糖＋酸＋维 C＋香精。差别主要在甜度酸度配比，不比谁更「健康」，比糖含量就行。' }
        ]
      },
      compare: {
        metric: '含糖量 g / 100mL',
        rows: [
          { name: '可乐', value: 10.6 }, { name: '脉动', value: 5.8 },
          { name: '维他命水', value: 8.0, me: true }, { name: '尖叫', value: 6.0 }, { name: '东方树叶', value: 0 }
        ]
      },
      ocrText: '配料表：水、白砂糖、果葡糖浆、柠檬酸、维生素C、烟酰胺、食用香精、柠檬酸钠 产品标准号：GB 7101 生产商：某饮料有限公司 厂址：广东省某市',
      lowConf: ['烟酰胺', '柠檬酸钠']
    }
  };

  var LIST = Object.keys(PRODUCTS).map(function (k) { return PRODUCTS[k]; });

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
    '赤藓糖醇': { flag: 'yellow', role: '代糖', what: '糖醇，甜度约蔗糖 65%，热量几乎为零。', why: '大部分原样排出，不参与血糖代谢。', caution: '一次较多容易腹胀、腹泻。' },
    '三氯蔗糖': { flag: 'yellow', role: '代糖', what: '高倍甜味剂，甜度约蔗糖 600 倍，用量极小。', why: '和别的代糖搭配把甜度补足。', caution: '合规添加；介意人工甜味剂可避开。' },
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
