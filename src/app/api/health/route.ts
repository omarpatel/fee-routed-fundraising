import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const headers = { "cache-control": "no-store" };

/** Platform health check (railway.json): 200 while the database answers, 503 otherwise. Public; reports nothing but up or down. */
export async function GET(): Promise<NextResponse> {
  try {
    await db.run(sql`select 1`);
    return NextResponse.json({ ok: true }, { headers });
  } catch (e) {
    console.error(`[health] database check failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
