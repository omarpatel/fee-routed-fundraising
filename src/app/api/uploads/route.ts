import { ApiError, fail, ok, requireApiSession, route } from "@/app/api/_lib";
import { IMAGE_KINDS, storeImage, UploadError, type ImageKind } from "@/lib/uploads";

/** multipart: `file` (png/jpg/webp ≤ 5 MB) + `kind` (token | cause | avatar). Session required. */
export const POST = route(async (req) => {
  await requireApiSession();
  const form = await req.formData().catch(() => {
    throw new ApiError("Expected multipart/form-data", 400);
  });
  const file = form.get("file");
  const kind = String(form.get("kind") ?? "");
  if (!(file instanceof File)) throw new ApiError("Missing file field", 400);
  if (!(IMAGE_KINDS as readonly string[]).includes(kind)) throw new ApiError(`kind must be one of ${IMAGE_KINDS.join(", ")}`, 400);
  try {
    return ok(await storeImage(file, kind as ImageKind), { status: 201 });
  } catch (e) {
    if (e instanceof UploadError) return fail(e.message, e.status);
    throw e;
  }
});
