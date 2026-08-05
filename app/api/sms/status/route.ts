import { NextRequest } from "next/server";
import { GET as getCode } from "../code/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return getCode(req);
}
