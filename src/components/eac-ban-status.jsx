
function relativeTimeFromNow(unixSeconds) {
  if (!unixSeconds) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  const days = Math.floor(diff / 86400);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  if (months < 12) return `${months}mo`;
  return `${years}y`;
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return null;
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

export function EacBanStatus({ bmData }) {
  if (!bmData) return null;

  const { rustBansBanned, rustBansCount, rustBansLastBan } = bmData;
  const hasEacHistory = rustBansCount > 0 || rustBansBanned;

  if (!hasEacHistory) return null;

  const relativeTime = relativeTimeFromNow(rustBansLastBan);
  const formattedDate = formatDate(rustBansLastBan);

  const banIcon = (
    <svg
      width="20"
      height="20"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
    >
      <path
        fill="currentColor"
        d="M50.967,44.031c-0.851,0.854-2.23,0.854-3.081,0.001l-27.873-27.9c-0.851-0.852-0.851-2.233,0-3.085
        L32.407,0.639c0.852-0.852,2.231-0.853,3.083,0l27.871,27.9c0.852,0.852,0.852,2.233,0,3.085L50.967,44.031z"
      />
      <path
        fill="currentColor"
        d="M7.695,63.405c-0.851,0.851-1.604,0.761-2.455,-0.091l-4.623-4.626c-0.851-0.853-0.809-1.474,0.042-2.326
        l35.437-35.472c0.851-0.852,2.363-1.786,3.214-0.935l4.622,4.628c0.852,0.851,0.049,2.497-0.801,3.348L7.695,63.405z"
      />
    </svg>
  );

  return (
    <div className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="text-danger mt-0.5">{banIcon}</div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground mb-1">
            {rustBansBanned ? "Currently EAC Banned" : "Not Currently EAC Banned"}
          </p>
          <p className="text-xs text-muted-foreground space-y-1">
            <span className="block">
              {rustBansCount} EAC ban{rustBansCount !== 1 ? "s" : ""} · verified
            </span>
            {rustBansLastBan && formattedDate && (
              <span className="block">
                Banned <time dateTime={new Date(rustBansLastBan * 1000).toISOString()}>
                  {formattedDate}
                </time>, <span className="font-mono">{relativeTime} ago</span>.
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
