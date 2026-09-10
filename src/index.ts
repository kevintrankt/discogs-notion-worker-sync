import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Discogs allows 60 authenticated requests/minute. Stay a bit under that to leave
// headroom for retries and to avoid moving-window edge cases.
const discogsApi = worker.pacer("discogsApi", {
	allowedRequests: 50,
	intervalMs: 60_000,
});

// Discogs occasionally omits cover_image (e.g. when a release has no image).
// Builder.file / Builder.imageIcon require a non-empty URL, so we fall back to
// a transparent 1x1 PNG hosted by Discogs' image CDN as a safe placeholder.
const PLACEHOLDER_COVER =
	"https://s.discogs.com/images/default-release-200.png";

const collection = worker.database("vinylCollection", {
	type: "managed",
	initialTitle: "Discog Vinyls (Worker)",
	primaryKeyProperty: "Instance ID",
	schema: {
		properties: {
			Album: Schema.title(),
			Artist: Schema.richText(),
			Year: Schema.number(),
			Label: Schema.richText(),
			"Catalog #": Schema.richText(),
			Format: Schema.richText(),
			Genres: Schema.richText(),
			Styles: Schema.richText(),
			Rating: Schema.number(),
			"Date Added": Schema.date(),
			"Discogs URL": Schema.url(),
			Cover: Schema.file(),
			"Instance ID": Schema.richText(),
			"Release ID": Schema.richText(),
		},
	},
});

worker.sync("collectionSync", {
	database: collection,
	mode: "replace",
	schedule: "1d",
	execute: async (state: { page?: number } | undefined) => {
		const token = requireEnv("DISCOGS_TOKEN");
		const page = state?.page ?? 1;

		await discogsApi.wait();
		const username = await getDiscogsUsername(token);

		await discogsApi.wait();
		const data = await fetchCollectionPage({ username, token, page });

		const changes = data.releases.map((item) => {
			const info = item.basic_information;
			const releaseId = String(info.id);
			const artistName = joinArtists(info.artists);
			const primaryLabel = info.labels?.[0];

			const coverUrl = info.cover_image || PLACEHOLDER_COVER;
			const coverAlt = info.title ?? "cover";

			return {
				type: "upsert" as const,
				key: String(item.instance_id),
				icon: Builder.imageIcon(coverUrl),
				pageContentMarkdown: `![${escapeMarkdown(coverAlt)}](${coverUrl})`,
				properties: {
					Album: Builder.title(info.title ?? "Untitled"),
					Artist: Builder.richText(artistName),
					Year: Builder.number(info.year ?? 0),
					Label: Builder.richText(primaryLabel?.name ?? ""),
					"Catalog #": Builder.richText(primaryLabel?.catno ?? ""),
					Format: Builder.richText(formatFormats(info.formats)),
					Genres: Builder.richText((info.genres ?? []).join(", ")),
					Styles: Builder.richText((info.styles ?? []).join(", ")),
					Rating: Builder.number(item.rating ?? 0),
					"Date Added": Builder.date(
						(item.date_added ?? "").slice(0, 10) || "1970-01-01",
					),
					"Discogs URL": Builder.url(
						`https://www.discogs.com/release/${releaseId}`,
					),
					Cover: Builder.file(coverUrl, `${coverAlt}.jpg`),
					"Instance ID": Builder.richText(String(item.instance_id)),
					"Release ID": Builder.richText(releaseId),
				},
			};
		});

		const totalPages = data.pagination?.pages ?? 1;
		const hasMore = page < totalPages;

		return {
			changes,
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});

// ---- Discogs API ----

type DiscogsArtist = { name: string; join?: string; anv?: string };
type DiscogsLabel = { name: string; catno?: string };
type DiscogsFormat = { name: string; qty?: string; descriptions?: string[] };

type DiscogsBasicInfo = {
	id: number;
	title?: string;
	year?: number;
	thumb?: string;
	cover_image?: string;
	artists?: DiscogsArtist[];
	labels?: DiscogsLabel[];
	formats?: DiscogsFormat[];
	genres?: string[];
	styles?: string[];
};

type DiscogsCollectionItem = {
	id: number;
	instance_id: number;
	folder_id: number;
	rating?: number;
	date_added?: string;
	basic_information: DiscogsBasicInfo;
};

type DiscogsCollectionResponse = {
	pagination: {
		page: number;
		pages: number;
		per_page: number;
		items: number;
	};
	releases: DiscogsCollectionItem[];
};

// Cache the username for the lifetime of this process. The token maps to
// exactly one Discogs user, so we only need to look it up once.
let cachedUsername: string | undefined;

async function getDiscogsUsername(token: string): Promise<string> {
	if (cachedUsername) return cachedUsername;
	const res = await fetch("https://api.discogs.com/oauth/identity", {
		headers: {
			Authorization: `Discogs token=${token}`,
			"User-Agent": "NotionDiscogsCollectionSync/1.0",
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`Discogs identity lookup failed: ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
		);
	}
	const json = (await res.json()) as { username?: string };
	if (!json.username) {
		throw new Error("Discogs identity response did not include a username.");
	}
	cachedUsername = json.username;
	return cachedUsername;
}

async function fetchCollectionPage(args: {
	username: string;
	token: string;
	page: number;
}): Promise<DiscogsCollectionResponse> {
	const url = new URL(
		`https://api.discogs.com/users/${encodeURIComponent(args.username)}/collection/folders/0/releases`,
	);
	url.searchParams.set("page", String(args.page));
	url.searchParams.set("per_page", "100");
	url.searchParams.set("sort", "added");
	url.searchParams.set("sort_order", "desc");

	const res = await fetch(url, {
		headers: {
			Authorization: `Discogs token=${args.token}`,
			"User-Agent": "NotionDiscogsCollectionSync/1.0",
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`Discogs API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
		);
	}

	return (await res.json()) as DiscogsCollectionResponse;
}

// ---- Helpers ----

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is not set. Add it to .env (local) or run 'ntn workers env push' after setting it (deployed).`,
		);
	}
	return value;
}

function joinArtists(artists: DiscogsArtist[] | undefined): string {
	if (!artists || artists.length === 0) return "";
	return artists
		.map((a, i) => {
			const name = a.anv && a.anv.length > 0 ? a.anv : a.name;
			const join = i < artists.length - 1 ? ` ${a.join || "&"} ` : "";
			return `${name}${join}`;
		})
		.join("")
		.trim();
}

// Escape characters that have special meaning in Markdown link/image alt text
// so a release title with `]` or `\` can't break the embedded image syntax.
function escapeMarkdown(text: string): string {
	return text.replace(/[\\\]\[]/g, (m) => `\\${m}`);
}

function formatFormats(formats: DiscogsFormat[] | undefined): string {
	if (!formats || formats.length === 0) return "";
	return formats
		.map((f) => {
			const desc = f.descriptions && f.descriptions.length > 0
				? ` (${f.descriptions.join(", ")})`
				: "";
			const qty = f.qty && f.qty !== "1" ? ` x${f.qty}` : "";
			return `${f.name}${desc}${qty}`;
		})
		.join(" / ");
}
