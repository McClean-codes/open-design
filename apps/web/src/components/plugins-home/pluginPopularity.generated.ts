// AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// Blended template popularity, used to order the plugin/example grid and the
// Home rail so the templates users actually reach for lead each category and
// sub-category (OPEND-449). Higher score = more popular; range [0, 1].
//
// How it is built (deterministic, creds-free transform):
//   score = 0.6 * norm(log1p(distinctUsers)) + 0.4 * norm(log1p(runs))
//   • window: trailing 28 days of `run_finished` events (by plugin_id)
//   • distinct users are the anti-gaming signal; runs add engagement depth
//   • log1p tames the head-template scale gap; min-max normalized over the
//     live-catalog template set so both metrics land in [0, 1]
//   • RETIRED plugins (absent from the live catalog) are dropped
//   • templates with no renderable preview are EXCLUDED — mode-seed entries
//     (e.g. the generic Live Artifact / HyperFrames options) live in the
//     composer mode picker, not the gallery, so usage must not float them up
//   • templates below 20 distinct users are OMITTED so thin-sample
//     tail templates keep their curated/visual fallback order
//
// Regenerate with: pnpm exec tsx scripts/refresh-plugin-popularity.ts --write
// Refreshed weekly by .github/workflows/refresh-plugin-popularity.yml.
// See pluginPopularity.RUNBOOK.md here.

export interface PluginPopularityMeta {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly weights: { readonly users: number; readonly runs: number };
  readonly minUsers: number;
  readonly count: number;
}

export const PLUGIN_POPULARITY_META: PluginPopularityMeta = {
  generatedAt: '2026-08-10',
  windowDays: 28,
  weights: { users: 0.6, runs: 0.4 },
  minUsers: 20,
  count: 94,
};

// Plugin id -> blended popularity score in [0, 1], most-popular first.
export const PLUGIN_POPULARITY: Readonly<Record<string, number>> = {
  'example-web-prototype': 1.0,
  'example-simple-deck': 0.858,
  'example-web-clone': 0.8362,
  'example-mobile-app': 0.6953,
  'example-open-design-landing': 0.6827,
  'example-webgl-experience': 0.6178,
  'example-gamified-app': 0.6064,
  'example-wireframe-mobile-flow': 0.5884,
  'example-kanban-board': 0.5698,
  'example-fs-creative-voltage': 0.5662,
  'example-wireframe-sketch': 0.5558,
  'example-fs-electric-studio': 0.5371,
  'example-mobile-onboarding': 0.5356,
  'example-fs-notebook-tabs': 0.5341,
  'image-template-anime-martial-arts-battle-illustration': 0.525,
  'example-digital-eguide': 0.52,
  'example-guizang-ppt': 0.5132,
  'example-social-carousel': 0.5101,
  'example-dashboard': 0.509,
  'example-wireframe-greybox': 0.5018,
  'example-fs-editorial-forest': 0.4955,
  'example-webgl-caustic-pool': 0.4944,
  'video-template-video-seedance-three-kingdoms-lyubu-yuanmen-archery': 0.4884,
  'example-video-hyperframes': 0.4851,
  'example-huashu-bento-insight': 0.4837,
  'example-social-media-matrix-tracker-template': 0.4802,
  'video-template-seedance-2-0-15-second-cinematic-japanese-romance-short-film': 0.4796,
  'example-resume-modern': 0.4685,
  'example-motion-frames': 0.4679,
  'example-huashu-keynote-black': 0.4676,
  'example-html-ppt-zhangzara-creative-mode': 0.4626,
  'example-html-ppt-course-module': 0.4583,
  'example-wireframe-annotated': 0.458,
  'example-huashu-slides': 0.4491,
  'image-template-e-commerce-live-stream-ui-mockup': 0.438,
  'video-template-frame-kinetic-type': 0.4321,
  'example-codex-interactive-capability-map': 0.4284,
  'example-html-ppt-knowledge-arch-blueprint': 0.4245,
  'example-hps-academic-paper': 0.4227,
  'image-template-profile-avatar-anime-girl-to-cinematic-photo': 0.4224,
  'example-html-ppt-zhangzara-capsule': 0.4213,
  'example-velar-luxury-real-estate': 0.4203,
  'image-template-profile-avatar-casual-fashion-grid-photoshoot': 0.4201,
  'example-fs-emerald-editorial': 0.415,
  'example-audio-jingle': 0.4104,
  'example-doc-kami-parchment': 0.4099,
  'example-huashu-golden-circle': 0.4058,
  'example-hps-bauhaus': 0.403,
  'example-html-ppt-hermes-cyber-terminal': 0.4025,
  'example-html-ppt-zhangzara-scatterbrain': 0.4023,
  'example-blog-post': 0.4013,
  'example-hps-true-blueprint': 0.3966,
  'example-image-poster': 0.3959,
  'example-mockup-device-3d': 0.3955,
  'video-template-luxury-supercar-cinematic-narrative': 0.3945,
  'example-trading-analysis-dashboard-template': 0.3915,
  'example-html-ppt-zhangzara-block-frame': 0.3898,
  'example-huashu-takram-soft-tech': 0.3898,
  'example-webgl-aurora-veil': 0.3888,
  'image-template-3d-stone-staircase-evolution-infographic': 0.3843,
  'example-pm-spec': 0.3813,
  'example-html-ppt-weekly-report': 0.3741,
  'example-open-design-landing-deck': 0.3722,
  'video-template-frame-logo-outro': 0.3715,
  'example-html-ppt-zhangzara-cobalt-grid': 0.3687,
  'image-template-notion-team-dashboard-live-artifact': 0.3677,
  'image-template-illustrated-city-food-map': 0.3664,
  'example-social-media-dashboard': 0.3647,
  'image-template-momotaro-explainer-slide-in-hybrid-style': 0.3626,
  'video-template-3d-animated-boy-building-lego': 0.3622,
  'example-huashu-sparkline-arc': 0.3613,
  'image-template-game-screenshot-anime-fighting-game-captain-ryuuga-vs-kaze-renshin': 0.3605,
  'image-template-social-media-post-showa-day-retro-culture-magazine-cover': 0.3555,
  'example-kami-deck': 0.3554,
  'image-template-illustration-crayon-kid-drawing-rework': 0.3551,
  'video-template-frame-build-minimal': 0.3549,
  'example-hps-y2k-chrome': 0.3528,
  'example-finance-report': 0.3515,
  'example-frontend-slides': 0.3456,
  'video-template-frame-bold-poster': 0.3447,
  'example-huashu-annual-letter': 0.3444,
  'example-hps-memphis-pop': 0.3442,
  'example-html-ppt-zhangzara-sakura-chroma': 0.3439,
  'video-template-frame-glitch-title': 0.3433,
  'example-deck-swiss-international': 0.3362,
  'example-docs-page': 0.3356,
  'image-template-profile-avatar-cinematic-south-asian-male-portrait-with-vultures': 0.3347,
  'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels': 0.3346,
  'example-huashu-pentagram-grid': 0.3344,
  'example-frame-logo-outro': 0.3254,
  'example-webgl-distortion-grain': 0.3229,
  'video-template-a-decade-of-refinement-glow-up': 0.3157,
  'video-template-frame-light-leak-cinema': 0.3127,
  'video-template-forbidden-city-cat-satire': 0.3065,
};

// Templates with no renderable preview — suppressed from the visual gallery
// grid so they never show as an empty letter card. They still reach users
// through the composer's mode picker. Repo-derived (baked manifest + on-disk
// `od.preview` entry existence), refreshed alongside the scores above.
export const PLUGIN_NO_PREVIEW: readonly string[] = [
  'example-dcf-valuation',
  'example-design-brief',
  'example-hatch-pet',
  'example-html-ppt',
  'example-hyperframes',
  'example-last30days',
  'example-live-artifact',
  'example-pptx-html-fidelity-audit',
  'example-x-research',
];
