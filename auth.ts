import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { PrismaClient } from "@prisma/client";
import { USER_ACTIVITY } from "@/lib/constants";

const prisma = new PrismaClient();

const THROTTLE_MS = USER_ACTIVITY.UPDATE_THROTTLE_HOURS * 60 * 60 * 1000;

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login", // 認証エラー時もログインページにリダイレクト
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, user }) {
      // 初回ログイン時にユーザーIDとロールをトークンに保存
      if (user) {
        token.id = user.id;
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id as string },
          select: { role: true },
        });
        token.role = dbUser?.role ?? "user";
        token.lastActivityAt = Date.now();
        await prisma.user.update({
          where: { id: user.id as string },
          data: { lastActivityAt: new Date() },
        });
      }

      // スロットル付きアクティビティ追跡（1時間に1回のみDB更新）
      const lastActivity = (token.lastActivityAt as number) || 0;
      if (Date.now() - lastActivity > THROTTLE_MS) {
        token.lastActivityAt = Date.now();
        if (token.id) {
          prisma.user
            .update({
              where: { id: token.id as string },
              data: { lastActivityAt: new Date() },
            })
            .catch((err: unknown) => {
              console.error("Failed to update lastActivityAt:", err);
            });
        }
      }

      return token;
    },
    async session({ session, token }) {
      // トークンからユーザーIDとロールをセッションに追加
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string) ?? "user";
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      // ログイン後の処理
      if (url.startsWith(baseUrl)) {
        // 既にbaseURLで始まる場合はそのまま返す
        return url;
      }
      // それ以外の場合はダッシュボードにリダイレクト
      return `${baseUrl}/dashboard`;
    },
  },
  trustHost: true,
});
