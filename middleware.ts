import { NextRequest, NextResponse } from 'next/server';

const authRealm = 'SWE Recruiting Tracker';

function challenge() {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${authRealm}", charset="UTF-8"` },
  });
}

function timingSafeEqual(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function isPublicPath(pathname: string) {
  return pathname === '/api/health'
    || pathname === '/favicon.ico'
    || pathname.startsWith('/_next/')
    || pathname.match(/\.(?:ico|png|jpg|jpeg|gif|svg|webp|css|js|woff2?)$/);
}

export function middleware(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next();

  const expectedPassword = process.env.APP_PASSWORD;
  if (!expectedPassword) {
    if (process.env.NODE_ENV !== 'production') return NextResponse.next();
    return new NextResponse('APP_PASSWORD must be set in production.', { status: 503 });
  }

  const expectedUsername = process.env.APP_USERNAME ?? 'riddhi';
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Basic ')) return challenge();

  let decoded = '';
  try {
    decoded = atob(authorization.slice('Basic '.length));
  } catch {
    return challenge();
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return challenge();

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (!timingSafeEqual(username, expectedUsername) || !timingSafeEqual(password, expectedPassword)) {
    return challenge();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
