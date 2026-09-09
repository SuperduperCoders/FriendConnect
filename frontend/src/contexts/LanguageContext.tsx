import { createContext, useContext, useState, ReactNode } from 'react';

type Lang = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'ko' | 'zh';

const TRANSLATIONS: Record<string, Record<string, string>> = {
  en: { chats: 'Chats', contacts: 'Contacts', shop: 'Shop', profile: 'Profile', games: 'Games', admin: 'Admin', send: 'Send', typeMessage: 'Type a message...', search: 'Search...', noChats: 'No chats yet', addFriend: 'Add Friend', yourId: 'Your ID', logout: 'Logout' },
  es: { chats: 'Chats', contacts: 'Contactos', shop: 'Tienda', profile: 'Perfil', games: 'Juegos', admin: 'Admin', send: 'Enviar', typeMessage: 'Escribe un mensaje...', search: 'Buscar...', noChats: 'Sin chats', addFriend: 'Agregar', yourId: 'Tu ID', logout: 'Salir' },
  fr: { chats: 'Discussions', contacts: 'Contacts', shop: 'Boutique', profile: 'Profil', games: 'Jeux', admin: 'Admin', send: 'Envoyer', typeMessage: 'Message...', search: 'Rechercher...', noChats: 'Aucune discussion', addFriend: 'Ajouter', yourId: 'Votre ID', logout: 'Déconnexion' },
  de: { chats: 'Chats', contacts: 'Kontakte', shop: 'Shop', profile: 'Profil', games: 'Spiele', admin: 'Admin', send: 'Senden', typeMessage: 'Nachricht...', search: 'Suchen...', noChats: 'Keine Chats', addFriend: 'Hinzufügen', yourId: 'Ihre ID', logout: 'Abmelden' },
  ja: { chats: 'チャット', contacts: '連絡先', shop: 'ショップ', profile: 'プロフィール', games: 'ゲーム', admin: '管理', send: '送信', typeMessage: 'メッセージ...', search: '検索...', noChats: 'チャットなし', addFriend: '追加', yourId: 'ID', logout: 'ログアウト' },
  ko: { chats: '채팅', contacts: '연락처', shop: '상점', profile: '프로필', games: '게임', admin: '관리', send: '보내기', typeMessage: '메시지...', search: '검색...', noChats: '채팅 없음', addFriend: '추가', yourId: 'ID', logout: '로그아웃' },
  zh: { chats: '聊天', contacts: '联系人', shop: '商店', profile: '个人资料', games: '游戏', admin: '管理', send: '发送', typeMessage: '输入消息...', search: '搜索...', noChats: '暂无聊天', addFriend: '添加', yourId: '你的ID', logout: '退出' },
};

interface LangCtx {
  lang: Lang; setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const Ctx = createContext<LangCtx>(null!);
export function useLanguage() { return useContext(Ctx); }

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('fc_lang') as Lang) || 'en');

  const setLanguage = (l: Lang) => { setLang(l); localStorage.setItem('fc_lang', l); };
  const t = (key: string) => TRANSLATIONS[lang]?.[key] || TRANSLATIONS.en[key] || key;

  return (
    <Ctx.Provider value={{ lang, setLang: setLanguage, t }}>
      {children}
    </Ctx.Provider>
  );
}
