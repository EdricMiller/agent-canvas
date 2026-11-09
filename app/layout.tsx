import type {Metadata} from 'next';
import './globals.css';

export const metadata:Metadata={title:'画语 Canvas · 设计工作台',description:'从灵感到可编辑设计稿，统一创作、校稿与下载。',icons:{icon:'/favicon.svg'}};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="zh-CN"><body>{children}</body></html>;
}
