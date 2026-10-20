import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'FOMO Companion',
    description: '单账户实时行情、真实持仓、条件单监控、操作日志和飞书通知。',
    minimum_chrome_version: '116',
    permissions: ['storage', 'sidePanel', 'alarms'],
    host_permissions: ['https://fomo.family/*', 'https://open.feishu.cn/open-apis/bot/v2/hook/*'],
    action: { default_title: '打开 FOMO 工作台' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
