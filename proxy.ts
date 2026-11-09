import {NextRequest,NextResponse} from 'next/server';

export function proxy(request:NextRequest){
  const nonce=Buffer.from(crypto.randomUUID()).toString('base64');
  const development=process.env.NODE_ENV!=='production';
  const csp=["default-src 'self'",`script-src 'self' 'nonce-${nonce}'${development?" 'unsafe-eval'":''}`,
    "style-src 'self' 'unsafe-inline'","img-src 'self' data: blob:","font-src 'self'",
    `connect-src 'self'${development?' ws:':''}`,"object-src 'none'","base-uri 'self'","frame-ancestors 'none'"].join('; ');
  const headers=new Headers(request.headers);headers.set('x-nonce',nonce);headers.set('Content-Security-Policy',csp);
  const response=NextResponse.next({request:{headers}});
  response.headers.set('Content-Security-Policy',csp);
  response.headers.set('X-Content-Type-Options','nosniff');
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('Cache-Control','no-store');
  return response;
}
export const config={matcher:['/((?!api/|images/|legacy/|_next/static|_next/image|favicon.svg).*)']};
