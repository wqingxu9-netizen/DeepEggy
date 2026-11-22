/* 食品过敏原数据（DeepEggy）
   依据：GB 7718-2025 标示的 14 类致敏物质 + 常见其他致敏食物
   数据来源：团队整理的《食品过敏原两张表》
   用法：DG_ALLERGENS.categories（列表）、DG_ALLERGENS.match(配料数组, 选中类别id数组) */
(function (root) {
  'use strict';

  // group: core = 国标要求标示的 14 类核心致敏物质；ext = 其他致敏食物（扩展提醒）
  // items: 配料表里可能出现的写法（用于包含匹配），按"从长到短"无顺序要求
  var categories = [
    // ---------- 核心致敏物质（14 类） ----------
    {
      id: 'gluten', group: 'core', name: '含麸质谷物', full: '含麸质谷物及其制品',
      include: '小麦、斯佩耳特小麦、硬粒小麦、呼罗珊小麦、黑麦、大麦、燕麦及其杂交品系',
      items: ['小麦', '斯佩耳特', '硬粒小麦', '呼罗珊', '黑麦', '大麦', '燕麦', '麸质', '麦芽', '全麦', '面筋']
    },
    {
      id: 'crustacean', group: 'core', name: '甲壳类', full: '甲壳纲动物及其制品',
      include: '虾、对虾、蟹、龙虾、小龙虾、螯虾、磷虾，以及虾粉、蟹粉、甲壳类提取物',
      items: ['虾', '蟹', '龙虾', '小龙虾', '螯虾', '磷虾', '虾粉', '蟹粉', '甲壳']
    },
    {
      id: 'egg', group: 'core', name: '蛋类', full: '蛋类及其制品',
      include: '鸡蛋、鸭蛋、鹅蛋、鹌鹑蛋；蛋清、蛋黄、蛋粉、卵白蛋白、卵清蛋白、部分蛋来源溶菌酶',
      items: ['鸡蛋', '鸭蛋', '鹅蛋', '鹌鹑蛋', '蛋清', '蛋黄', '蛋粉', '全蛋', '卵白', '卵清', '溶菌酶']
    },
    {
      id: 'fish', group: 'core', name: '鱼类', full: '鱼类及其制品',
      include: '鳕鱼、鲑鱼、金枪鱼、鲈鱼等海水鱼和淡水鱼；鱼子、鱼露、鱼粉、鱼明胶、鱼胶原蛋白',
      items: ['鳕鱼', '鲑鱼', '金枪鱼', '鲈鱼', '鱼子', '鱼露', '鱼粉', '鱼明胶', '鱼胶原', '鱼油', '鳕', '鲑']
    },
    {
      id: 'peanut', group: 'core', name: '花生', full: '花生及其制品',
      include: '花生仁、花生酱、花生粉、花生蛋白、部分花生油（花生属于豆科，不是树坚果）',
      items: ['花生']
    },
    {
      id: 'soy', group: 'core', name: '大豆', full: '大豆及其制品',
      include: '黄豆、毛豆、豆浆、豆腐、酱油、味噌、纳豆、豆豉、大豆蛋白、大豆卵磷脂等',
      items: ['大豆', '黄豆', '毛豆', '豆浆', '豆腐', '酱油', '味噌', '纳豆', '豆豉', '豆奶', '大豆蛋白', '大豆卵磷脂', '腐竹', '豆皮']
    },
    {
      id: 'milk', group: 'core', name: '乳及乳制品', full: '乳及乳制品',
      include: '牛奶、山羊奶、绵羊奶等；奶粉、奶酪、奶油、黄油、酸奶、炼乳、酪蛋白、乳清蛋白',
      items: ['生牛乳', '牛乳', '牛奶', '羊奶', '奶粉', '乳粉', '奶酪', '奶油', '黄油', '酸奶', '炼乳', '酪蛋白', '乳清', '稀奶油', '乳制品']
    },
    {
      id: 'treenut', group: 'core', name: '树坚果', full: '树坚果及其制品',
      include: '杏仁、榛子、核桃、腰果、山核桃、巴西坚果、开心果、澳洲坚果，以及坚果酱、坚果粉、坚果蛋白',
      items: ['杏仁', '榛子', '核桃', '腰果', '山核桃', '巴西坚果', '开心果', '澳洲坚果', '坚果酱', '坚果粉', '坚果蛋白']
    },
    {
      id: 'celery', group: 'core', name: '芹菜', full: '芹菜及其制品',
      include: '芹菜茎、叶、籽、根芹菜、芹菜粉、芹菜盐及芹菜调味料',
      items: ['芹菜']
    },
    {
      id: 'mustard', group: 'core', name: '芥末', full: '芥末及其制品',
      include: '芥末籽、芥末粉、芥末酱、芥末油及含芥末的复合调味料',
      items: ['芥末']
    },
    {
      id: 'sesame', group: 'core', name: '芝麻', full: '芝麻及其制品',
      include: '芝麻籽、芝麻酱、芝麻粉、芝麻油及含芝麻的调味料',
      items: ['芝麻']
    },
    {
      id: 'sulfite', group: 'core', name: '二氧化硫', full: '二氧化硫和亚硫酸盐',
      include: '欧盟规定成品中总 SO₂ 超过 10 mg/kg 或 10 mg/L 时须标示；常见于葡萄酒、干果、腌制品',
      items: ['二氧化硫', '亚硫酸', '焦亚硫酸', '亚硫酸钠', '亚硫酸氢钠', '偏亚硫酸氢钠']
    },
    {
      id: 'lupin', group: 'core', name: '羽扇豆', full: '羽扇豆及其制品',
      include: '羽扇豆籽、羽扇豆粉、羽扇豆蛋白，可能用于面包、糕点、面食和植物蛋白产品',
      items: ['羽扇豆']
    },
    {
      id: 'mollusc', group: 'core', name: '软体动物', full: '软体动物及其制品',
      include: '蛤蜊、牡蛎、贻贝、扇贝、鲍鱼、螺类，以及鱿鱼、章鱼、乌贼等',
      items: ['蛤蜊', '牡蛎', '贻贝', '扇贝', '鲍鱼', '螺', '鱿鱼', '章鱼', '乌贼', '墨鱼', '蛏子']
    },

    // ---------- 其他致敏食物（扩展提醒） ----------
    {
      id: 'other_grains', group: 'ext', name: '其他谷物', full: '其他谷物、假谷物',
      include: '荞麦、大米、玉米、小米、高粱、藜麦、苋籽等',
      items: ['荞麦', '大米', '玉米', '小米', '高粱', '藜麦', '苋籽', '黑米', '糯米']
    },
    {
      id: 'other_legumes', group: 'ext', name: '其他豆类', full: '其他豆类',
      include: '豌豆、扁豆、鹰嘴豆、蚕豆、菜豆、绿豆、红豆、豇豆等',
      items: ['豌豆', '扁豆', '鹰嘴豆', '蚕豆', '菜豆', '绿豆', '红豆', '豇豆']
    },
    {
      id: 'other_nuts', group: 'ext', name: '其他坚果种籽', full: '其他坚果和种籽',
      include: '松子、栗子、椰子、葵花籽、南瓜籽、罂粟籽、亚麻籽、奇亚籽、火麻籽等',
      items: ['松子', '栗子', '椰子', '葵花籽', '南瓜籽', '罂粟籽', '亚麻籽', '奇亚籽', '火麻籽']
    },
    {
      id: 'fruit', group: 'ext', name: '水果', full: '水果',
      include: '猕猴桃、苹果、香蕉、芒果、柑橘、草莓、樱桃、李子、甜瓜、西瓜、鳄梨等',
      items: ['猕猴桃', '苹果', '香蕉', '芒果', '柑橘', '草莓', '樱桃', '李子', '甜瓜', '西瓜', '鳄梨', '葡萄', '菠萝', '蓝莓', '桃子', '橙子', '柚子', '荔枝', '龙眼', '哈密瓜', '水蜜桃']
    },
    {
      id: 'vegetable', group: 'ext', name: '蔬菜', full: '蔬菜',
      include: '胡萝卜、番茄、马铃薯、洋葱等；新鲜果蔬常与口腔过敏综合征有关',
      items: ['胡萝卜', '番茄', '西红柿', '马铃薯', '土豆', '洋葱']
    },
    {
      id: 'meat', group: 'ext', name: '肉类', full: '肉类及动物来源成分',
      include: '牛肉、猪肉、羊肉、山羊肉、鸡肉、鸭肉、火鸡肉，以及明胶等',
      items: ['牛肉', '猪肉', '羊肉', '鸡肉', '鸭肉', '火鸡肉', '明胶']
    },
    {
      id: 'alpha_gal', group: 'ext', name: 'α-半乳糖相关', full: 'α-半乳糖相关食物（α-gal 过敏）',
      include: '牛肉、猪肉、羊肉等哺乳动物肉和部分哺乳动物制品；过敏原相关结构是糖链，而非普通蛋白质',
      items: ['哺乳动物肉', '牛肉', '猪肉', '羊肉']
    },
    {
      id: 'bee', group: 'ext', name: '蜂产品', full: '蜂产品',
      include: '蜂蜜、蜂王浆、食用蜂花粉、蜂胶等',
      items: ['蜂蜜', '蜂王浆', '蜂花粉', '蜂胶']
    },
    {
      id: 'spice', group: 'ext', name: '香辛料', full: '香草和香辛料',
      include: '芫荽／香菜、大蒜、辣椒、花椒、胡椒及含这些香辛料的复合调味料',
      items: ['芫荽', '香菜', '大蒜', '香辛料', '辣椒', '花椒', '胡椒']
    },
    {
      id: 'insect', group: 'ext', name: '食用昆虫', full: '食用昆虫及新型蛋白食品',
      include: '黄粉虫、蟋蟀、蝗虫、蚕蛹等；还需关注其与甲壳类可能存在的交叉反应',
      items: ['黄粉虫', '蟋蟀', '蝗虫', '蚕蛹', '昆虫']
    },
    {
      id: 'other', group: 'ext', name: '其他加工制品', full: '其他食物及加工制品',
      include: '任何其他含致敏蛋白的食物、提取物、蛋白粉、调味料、加工助剂或复合配料',
      items: []
    },
    // ---------- 花粉-食物交叉反应（过敏体质重点） ----------
    {
      id: 'birch_pollen', group: 'ext', name: '桦树花粉交叉', full: '桦树花粉-食物过敏综合征相关',
      include: '苹果、樱桃、榛子、芹菜、胡萝卜、猕猴桃、李子、梨（生吃更易发作，煮熟常可耐受）',
      items: ['苹果', '樱桃', '榛子', '芹菜', '胡萝卜', '猕猴桃', '李子', '梨'], 
      aliases: ['桦树花粉', '花粉症', '口腔过敏综合征']
    },
    {
      id: 'mugwort_pollen', group: 'ext', name: '蒿草花粉交叉', full: '蒿草花粉相关食物',
      include: '芹菜、胡萝卜、香料、荔枝、芒果等（北方秋季花粉症人群注意）',
      items: ['芹菜', '胡萝卜', '荔枝', '芒果', '香料'],
      aliases: ['蒿草', '秋季花粉']
    },
    {
      id: 'latex', group: 'ext', name: '乳胶交叉', full: '乳胶-水果过敏综合征相关',
      include: '香蕉、牛油果、栗子、猕猴桃、芒果等（对乳胶手套过敏的人注意）',
      items: ['香蕉', '牛油果', '鳄梨', '栗子', '猕猴桃'],
      aliases: ['乳胶过敏', '橡胶手套']
    },
    {
      id: 'ragweed', group: 'ext', name: '豚草交叉', full: '豚草花粉相关食物',
      include: '甜瓜、西葫芦、香蕉、黄瓜等（秋季花粉症人群注意）',
      items: ['甜瓜', '西葫芦', '香蕉', '黄瓜'],
      aliases: ['豚草']
    },
    // ---------- 中国常见地区性过敏食物 ----------
    {
      id: 'mango', group: 'ext', name: '芒果', full: '芒果及其制品',
      include: '鲜芒果、芒果干、芒果汁（漆酚类成分，南方常见，常表现为口周红痒）',
      items: ['芒果', '芒果干', '芒果汁'],
      aliases: ['芒果过敏']
    },
    {
      id: 'peach', group: 'ext', name: '桃', full: '桃及其制品',
      include: '鲜桃、水蜜桃、黄桃、桃汁、桃脯（中国儿童常见过敏原）',
      items: ['桃子', '水蜜桃', '黄桃', '桃汁', '桃脯', '桃'],
      aliases: ['桃子过敏', '毛桃']
    },
    {
      id: 'kiwi', group: 'ext', name: '猕猴桃', full: '猕猴桃及其制品',
      include: '鲜猕猴桃、奇异果果汁（常与乳胶过敏交叉）',
      items: ['猕猴桃', '奇异果'],
      aliases: ['奇异果']
    },
    {
      id: 'buckwheat', group: 'ext', name: '荞麦', full: '荞麦及其制品',
      include: '荞麦面、荞麦粉、荞麦茶（亚洲常见，荞麦枕头也可能引发）',
      items: ['荞麦', '荞麦粉', '荞麦茶'],
      aliases: ['荞麦过敏']
    },
    {
      id: 'garlic', group: 'ext', name: '大蒜', full: '大蒜及其制品',
      include: '大蒜、蒜粉、蒜蓉、蒜油（常引起接触性皮炎和肠胃不适）',
      items: ['大蒜', '蒜粉', '蒜蓉', '蒜油', '蒜'],
      aliases: ['蒜', '大蒜过敏']
    },
    {
      id: 'mustard_wasabi', group: 'ext', name: '芥末/辣根', full: '芥末、辣根、山葵及其制品',
      include: '芥末、辣根、山葵（芥末家族同属十字花科，芥末过敏者注意辣根）',
      items: ['芥末', '辣根', '山葵', '青芥辣'],
      aliases: ['芥末过敏', '辣根', '山葵']
    }
  ];

  var byId = {};
  categories.forEach(function (c) { byId[c.id] = c; });

  /**
   * 匹配过敏原
   * @param {Array} ingredients 配料数组，元素含 name 字段
   * @param {Array} selectedIds 选中的过敏原类别 id 数组
   * @returns {Array} [{ id, name, full, group, matched: [配料原文] }]
   */
  function match(ingredients, selectedIds) {
    var hits = [];
    (selectedIds || []).forEach(function (id) {
      var cat = byId[id];
      if (!cat || !cat.items.length) return;
      var matched = [];
      (ingredients || []).forEach(function (ing) {
        var name = (ing && ing.name) || '';
        if (!name) return;
        if (cat.items.some(function (k) { return name.indexOf(k) !== -1; })) {
          if (matched.indexOf(name) === -1) matched.push(name);
        }
      });
      if (matched.length) {
        hits.push({ id: cat.id, name: cat.name, full: cat.full, group: cat.group, matched: matched });
      }
    });
    return hits;
  }

  root.DG_ALLERGENS = { categories: categories, byId: byId, match: match };
})(window);
