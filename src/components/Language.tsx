import { createContext, useContext } from 'react';
import { translator, type Language, type Translate } from '../shared/i18n';

export const LanguageContext = createContext<{ language: Language; t: Translate }>({ language: 'zh-CN', t: translator('zh-CN') });
export const useLanguage = () => useContext(LanguageContext);
export function cachedLanguage(): Language {
  try { return localStorage.getItem('fomo-language') === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
}
