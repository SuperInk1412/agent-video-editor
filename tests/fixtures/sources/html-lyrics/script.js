// 共享夹具 · html-lyrics（docs/DESIGN-BACKEND-V2.md §10.4.6，WP4.0）
//
// 由常量数组生成歌词行。没有时钟、没有随机、没有定时器：同一份文件每次加载得到
// 同一棵 DOM，编译（WP4.1）在任意帧取样都稳定。每行带 data-vdm-id 与 --i，
// 动画完全交给 style.css（延迟 = --i × --stagger）。
const LINES = [
  '第一句：夏天在玻璃上碎成很多个太阳',
  '第二句：我们数着站名，像数没说完的话',
  '第三句：隧道把光折起来，又慢慢摊开',
  '第四句：你说明天要早起，去很远的北方',
  '第五句：于是整个夜晚都开始向北漂移',
  '第六句：而我留在原地，等最后一班车',
];

const list = document.getElementById('lines');

LINES.forEach((text, index) => {
  const item = document.createElement('li');
  item.className = 'line';
  item.dataset.vdmId = `n_line_${index + 1}`;
  item.style.setProperty('--i', String(index));
  item.textContent = text;
  list.append(item);
});
