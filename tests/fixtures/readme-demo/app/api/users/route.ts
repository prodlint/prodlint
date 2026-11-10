import { db } from "@/lib/db";

export async function POST(req: Request) {
  const { email, role } = await req.json();
  const user = await db.user.create({ data: { email, role } });
  return Response.json(user);
}
