export type FixtureFilename =
  | 'avatar.json'
  | 'highlights-tray.json'
  | 'highlights.json'
  | 'instants-photo.json'
  | 'instants-video.json'
  | 'instants-empty.json'
  | 'shortcode-image.json'
  | 'shortcode-sidecar.json'
  | 'shortcode-video.json'
  | 'story.json'
  | 'web-profile-info.json';

export const FIXTURE_FILENAMES: ReadonlyArray<FixtureFilename> = [
  'avatar.json',
  'highlights-tray.json',
  'highlights.json',
  'shortcode-image.json',
  'shortcode-sidecar.json',
  'shortcode-video.json',
  'story.json',
  'web-profile-info.json',
  'instants-photo.json',
  'instants-video.json',
  'instants-empty.json',
];

export type PrimitiveType = 'boolean' | 'number' | 'string';
export type EntityKind = 'PERSON' | 'MEDIA' | 'LOCATION' | 'AUDIO';
export type IdentifierNamespace =
  | 'PERSON_IG'
  | 'PERSON_USERNAME'
  | 'PERSON_FB'
  | 'PERSON_EIMU'
  | 'MEDIA_ID'
  | 'MEDIA_UPLOAD_ID'
  | 'MEDIA_SHORTCODE'
  | 'LOCATION_ID'
  | 'AUDIO_ID';

export type PolicyAction =
  | { readonly tag: 'preserve' }
  | {
      readonly tag: 'entityField';
      readonly entity: EntityKind;
      readonly recordPath: string;
      readonly role: string;
      readonly namespace?: IdentifierNamespace;
    }
  | {
      readonly tag: 'url';
      readonly role: string;
      readonly entity?: EntityKind;
      readonly recordPath?: string;
    }
  | { readonly tag: 'opaque'; readonly category: string }
  | { readonly tag: 'embeddedAddressJson' };

export interface PolicyRule {
  readonly path: string;
  readonly types: ReadonlyArray<PrimitiveType>;
  readonly action: PolicyAction;
}

export interface FixturePolicy {
  readonly rules: ReadonlyArray<PolicyRule>;
  readonly emptyContainers?: ReadonlyArray<{
    readonly path: string;
    readonly type: 'array' | 'object';
  }>;
}

const emptyArray = (path: string): { readonly path: string; readonly type: 'array' } => ({
  path,
  type: 'array',
});
const emptyObject = (path: string): { readonly path: string; readonly type: 'object' } => ({
  path,
  type: 'object',
});

const preserve = (path: string, types: ReadonlyArray<PrimitiveType> = ['string']): PolicyRule => ({
  path,
  types,
  action: { tag: 'preserve' },
});

const opaque = (path: string, category: string): PolicyRule => ({
  path,
  types: ['string'],
  action: { tag: 'opaque', category },
});

const entityField = (
  path: string,
  entity: EntityKind,
  recordPath: string,
  role: string,
  types: ReadonlyArray<PrimitiveType> = ['string'],
  namespace?: IdentifierNamespace
): PolicyRule => ({
  path,
  types,
  action: { tag: 'entityField', entity, recordPath, role, namespace },
});

const url = (path: string, role: string, entity?: EntityKind, recordPath?: string): PolicyRule => ({
  path,
  types: ['string'],
  action: { tag: 'url', role, entity, recordPath },
});

const person = (prefix: string): ReadonlyArray<PolicyRule> => [
  entityField(`${prefix}.id`, 'PERSON', prefix, 'ID', ['string', 'number'], 'PERSON_IG'),
  entityField(`${prefix}.pk`, 'PERSON', prefix, 'ID', ['string', 'number'], 'PERSON_IG'),
  entityField(`${prefix}.pk_id`, 'PERSON', prefix, 'ID', ['string', 'number'], 'PERSON_IG'),
  entityField(`${prefix}.strong_id__`, 'PERSON', prefix, 'ID', ['string', 'number'], 'PERSON_IG'),
  entityField(`${prefix}.username`, 'PERSON', prefix, 'USERNAME', ['string'], 'PERSON_USERNAME'),
  entityField(`${prefix}.full_name`, 'PERSON', prefix, 'FULL_NAME'),
  url(`${prefix}.profile_pic_url`, 'PROFILE_PICTURE', 'PERSON', prefix),
];

const dimensions = (prefix: string): ReadonlyArray<PolicyRule> => [
  preserve(`${prefix}.height`, ['number']),
  preserve(`${prefix}.width`, ['number']),
];

const resource = (prefix: string, mediaRecord: string): ReadonlyArray<PolicyRule> => [
  url(`${prefix}.src`, 'RESOURCE', 'MEDIA', mediaRecord),
  preserve(`${prefix}.config_height`, ['number']),
  preserve(`${prefix}.config_width`, ['number']),
];

const storyItem = (prefix: string): ReadonlyArray<PolicyRule> => [
  preserve(`${prefix}.__typename`),
  entityField(`${prefix}.id`, 'MEDIA', prefix, 'ID', ['string', 'number'], 'MEDIA_ID'),
  preserve(`${prefix}.is_video`, ['boolean']),
  url(`${prefix}.display_url`, 'DISPLAY', 'MEDIA', prefix),
  ...resource(`${prefix}.display_resources[]`, prefix),
  ...resource(`${prefix}.video_resources[]`, prefix),
  preserve(`${prefix}.video_resources[].mime_type`),
  preserve(`${prefix}.video_resources[].profile`),
  ...dimensions(`${prefix}.dimensions`),
  preserve(`${prefix}.taken_at_timestamp`, ['number']),
  preserve(`${prefix}.expiring_at_timestamp`, ['number']),
  preserve(`${prefix}.video_duration`, ['number']),
  preserve(`${prefix}.should_log_client_event`, ['boolean']),
  url(`${prefix}.story_cta_url`, 'STORY_CTA', 'MEDIA', prefix),
  preserve(`${prefix}.story_view_count`, ['number']),
  opaque(`${prefix}.media_preview`, 'MEDIA_PREVIEW'),
  opaque(`${prefix}.tracking_token`, 'TRACKING_TOKEN'),
  ...person(`${prefix}.owner`),
  preserve(`${prefix}.tappable_objects[].__typename`),
  preserve(`${prefix}.tappable_objects[].height`, ['number']),
  preserve(`${prefix}.tappable_objects[].rotation`, ['number']),
  preserve(`${prefix}.tappable_objects[].width`, ['number']),
  preserve(`${prefix}.tappable_objects[].x`, ['number']),
  preserve(`${prefix}.tappable_objects[].y`, ['number']),
  opaque(`${prefix}.tappable_objects[].id`, 'TAPPABLE_ID'),
  opaque(`${prefix}.tappable_objects[].short_name`, 'TAPPABLE_TEXT'),
  opaque(`${prefix}.tappable_objects[].custom_title`, 'TAPPABLE_TEXT'),
  opaque(`${prefix}.tappable_objects[].attribution`, 'TAPPABLE_TEXT'),
];

const reel = (prefix: string): ReadonlyArray<PolicyRule> => [
  preserve(`${prefix}.__typename`),
  entityField(`${prefix}.id`, 'MEDIA', prefix, 'ID', ['string', 'number'], 'MEDIA_ID'),
  preserve(`${prefix}.latest_reel_media`, ['number']),
  preserve(`${prefix}.expiring_at`, ['number']),
  preserve(`${prefix}.seen`, ['number']),
  ...person(`${prefix}.owner`),
  preserve(`${prefix}.owner.__typename`),
  ...person(`${prefix}.user`),
  preserve(`${prefix}.user.followed_by_viewer`, ['boolean']),
  preserve(`${prefix}.user.requested_by_viewer`, ['boolean']),
  ...storyItem(`${prefix}.items[]`),
];

const graphqlErrors: ReadonlyArray<PolicyRule> = [
  preserve('errors[].message'),
  preserve('errors[].path[]', ['string', 'number']),
  preserve('errors[].severity'),
];

const shortcodeRoot = 'data.xdt_shortcode_media';
const shortcodeCommon: ReadonlyArray<PolicyRule> = [
  preserve(`${shortcodeRoot}.__isXDTGraphMediaInterface`),
  preserve(`${shortcodeRoot}.__typename`),
  entityField(
    `${shortcodeRoot}.id`,
    'MEDIA',
    shortcodeRoot,
    'ID',
    ['string', 'number'],
    'MEDIA_ID'
  ),
  entityField(
    `${shortcodeRoot}.shortcode`,
    'MEDIA',
    shortcodeRoot,
    'SHORTCODE',
    ['string'],
    'MEDIA_SHORTCODE'
  ),
  opaque(`${shortcodeRoot}.accessibility_caption`, 'ACCESSIBILITY_CAPTION'),
  ...dimensions(`${shortcodeRoot}.dimensions`),
  url(`${shortcodeRoot}.display_url`, 'DISPLAY', 'MEDIA', shortcodeRoot),
  ...resource(`${shortcodeRoot}.display_resources[]`, shortcodeRoot),
  url(`${shortcodeRoot}.thumbnail_src`, 'THUMBNAIL', 'MEDIA', shortcodeRoot),
  opaque(`${shortcodeRoot}.media_preview`, 'MEDIA_PREVIEW'),
  opaque(`${shortcodeRoot}.tracking_token`, 'TRACKING_TOKEN'),
  preserve(`${shortcodeRoot}.taken_at_timestamp`, ['number']),
  opaque(`${shortcodeRoot}.fact_check_overall_rating`, 'FACT_CHECK'),
  opaque(`${shortcodeRoot}.fact_check_information`, 'FACT_CHECK'),
  preserve(`${shortcodeRoot}.encoding_status`),
  preserve(`${shortcodeRoot}.is_video`, ['boolean']),
  preserve(`${shortcodeRoot}.can_see_insights_as_brand`, ['boolean']),
  preserve(`${shortcodeRoot}.caption_is_edited`, ['boolean']),
  preserve(`${shortcodeRoot}.commenting_disabled_for_viewer`, ['boolean']),
  preserve(`${shortcodeRoot}.comments_disabled`, ['boolean']),
  preserve(`${shortcodeRoot}.is_ad`, ['boolean']),
  preserve(`${shortcodeRoot}.is_affiliate`, ['boolean']),
  preserve(`${shortcodeRoot}.is_paid_partnership`, ['boolean']),
  preserve(`${shortcodeRoot}.viewer_has_saved`, ['boolean']),
  preserve(`${shortcodeRoot}.viewer_has_saved_to_collection`, ['boolean']),
  preserve(`${shortcodeRoot}.viewer_in_photo_of_you`, ['boolean']),
  preserve(`${shortcodeRoot}.edge_media_preview_like.count`, ['number']),
  ...person(`${shortcodeRoot}.edge_media_preview_like.edges[].node`),
  preserve(`${shortcodeRoot}.edge_media_preview_like.edges[].node.is_verified`, ['boolean']),
  preserve(`${shortcodeRoot}.edge_media_to_comment.count`, ['number']),
  opaque(`${shortcodeRoot}.edge_media_to_comment.page_info.end_cursor`, 'CURSOR'),
  preserve(`${shortcodeRoot}.edge_media_to_comment.page_info.has_next_page`, ['boolean']),
  opaque(`${shortcodeRoot}.edge_media_to_caption.edges[].node.id`, 'CAPTION_ID'),
  preserve(`${shortcodeRoot}.edge_media_to_caption.edges[].node.created_at`),
  opaque(`${shortcodeRoot}.edge_media_to_caption.edges[].node.text`, 'CAPTION'),
  preserve(`${shortcodeRoot}.has_ranked_comments`, ['boolean']),
  preserve(`${shortcodeRoot}.like_and_view_counts_disabled`, ['boolean']),
  preserve(`${shortcodeRoot}.viewer_can_reshare`, ['boolean']),
  preserve(`${shortcodeRoot}.viewer_has_liked`, ['boolean']),
  ...person(`${shortcodeRoot}.owner`),
  preserve(`${shortcodeRoot}.owner.edge_followed_by.count`, ['number']),
  preserve(`${shortcodeRoot}.owner.edge_owner_to_timeline_media.count`, ['number']),
  preserve(`${shortcodeRoot}.owner.followed_by_viewer`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.is_embeds_disabled`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.is_private`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.pass_tiering_recommendation`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.is_verified`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.blocked_by_viewer`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.restricted_by_viewer`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.has_blocked_viewer`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.is_unpublished`, ['boolean']),
  preserve(`${shortcodeRoot}.owner.requested_by_viewer`, ['boolean']),
  ...person(`${shortcodeRoot}.coauthor_producers[]`),
  preserve(`${shortcodeRoot}.coauthor_producers[].is_verified`, ['boolean']),
  preserve(`${shortcodeRoot}.sharing_friction_info.should_have_sharing_friction`, ['boolean']),
  url(`${shortcodeRoot}.sharing_friction_info.bloks_app_url`, 'SHARING_FRICTION'),
  entityField(
    `${shortcodeRoot}.location.id`,
    'LOCATION',
    `${shortcodeRoot}.location`,
    'ID',
    ['string', 'number'],
    'LOCATION_ID'
  ),
  entityField(`${shortcodeRoot}.location.name`, 'LOCATION', `${shortcodeRoot}.location`, 'NAME'),
  entityField(`${shortcodeRoot}.location.slug`, 'LOCATION', `${shortcodeRoot}.location`, 'SLUG'),
  preserve(`${shortcodeRoot}.location.has_public_page`, ['boolean']),
  {
    path: `${shortcodeRoot}.location.address_json`,
    types: ['string'],
    action: { tag: 'embeddedAddressJson' },
  },
];

const sidecarChild = `${shortcodeRoot}.edge_sidecar_to_children.edges[].node`;
const sidecarRules: ReadonlyArray<PolicyRule> = [
  ...shortcodeCommon,
  preserve(`${sidecarChild}.__typename`),
  opaque(`${sidecarChild}.accessibility_caption`, 'ACCESSIBILITY_CAPTION'),
  entityField(`${sidecarChild}.id`, 'MEDIA', sidecarChild, 'ID', ['string', 'number'], 'MEDIA_ID'),
  entityField(
    `${sidecarChild}.shortcode`,
    'MEDIA',
    sidecarChild,
    'SHORTCODE',
    ['string'],
    'MEDIA_SHORTCODE'
  ),
  preserve(`${sidecarChild}.is_video`, ['boolean']),
  ...dimensions(`${sidecarChild}.dimensions`),
  url(`${sidecarChild}.display_url`, 'DISPLAY', 'MEDIA', sidecarChild),
  ...resource(`${sidecarChild}.display_resources[]`, sidecarChild),
  url(`${sidecarChild}.video_url`, 'VIDEO', 'MEDIA', sidecarChild),
  opaque(`${sidecarChild}.media_preview`, 'MEDIA_PREVIEW'),
  opaque(`${sidecarChild}.tracking_token`, 'TRACKING_TOKEN'),
  preserve(`${sidecarChild}.video_view_count`, ['number']),
  preserve(`${sidecarChild}.video_play_count`, ['number']),
  preserve(`${sidecarChild}.has_audio`, ['boolean']),
  opaque(`${sidecarChild}.fact_check_overall_rating`, 'FACT_CHECK'),
  opaque(`${sidecarChild}.fact_check_information`, 'FACT_CHECK'),
  preserve(`${sidecarChild}.dash_info.is_dash_eligible`, ['boolean']),
  preserve(`${sidecarChild}.dash_info.number_of_qualities`, ['number']),
  opaque(`${sidecarChild}.dash_info.video_dash_manifest`, 'DASH_MANIFEST'),
  preserve(`${sidecarChild}.sharing_friction_info.should_have_sharing_friction`, ['boolean']),
  url(`${sidecarChild}.sharing_friction_info.bloks_app_url`, 'SHARING_FRICTION'),
];

const videoRules: ReadonlyArray<PolicyRule> = [
  ...shortcodeCommon,
  preserve(`${shortcodeRoot}.dash_info.number_of_qualities`, ['number']),
  preserve(`${shortcodeRoot}.dash_info.is_dash_eligible`, ['boolean']),
  opaque(`${shortcodeRoot}.dash_info.video_dash_manifest`, 'DASH_MANIFEST'),
  preserve(`${shortcodeRoot}.has_audio`, ['boolean']),
  preserve(`${shortcodeRoot}.is_published`, ['boolean']),
  preserve(`${shortcodeRoot}.is_video`, ['boolean']),
  preserve(`${shortcodeRoot}.product_type`),
  opaque(`${shortcodeRoot}.title`, 'TITLE'),
  preserve(`${shortcodeRoot}.video_duration`, ['number']),
  preserve(`${shortcodeRoot}.video_play_count`, ['number']),
  preserve(`${shortcodeRoot}.video_view_count`, ['number']),
  url(`${shortcodeRoot}.video_url`, 'VIDEO', 'MEDIA', shortcodeRoot),
  entityField(
    `${shortcodeRoot}.clips_music_attribution_info.audio_id`,
    'AUDIO',
    `${shortcodeRoot}.clips_music_attribution_info`,
    'ID',
    ['string', 'number'],
    'AUDIO_ID'
  ),
  entityField(
    `${shortcodeRoot}.clips_music_attribution_info.artist_name`,
    'AUDIO',
    `${shortcodeRoot}.clips_music_attribution_info`,
    'ARTIST'
  ),
  entityField(
    `${shortcodeRoot}.clips_music_attribution_info.song_name`,
    'AUDIO',
    `${shortcodeRoot}.clips_music_attribution_info`,
    'SONG'
  ),
  opaque(`${shortcodeRoot}.clips_music_attribution_info.should_mute_audio_reason`, 'AUDIO_REASON'),
  preserve(`${shortcodeRoot}.clips_music_attribution_info.uses_original_audio`, ['boolean']),
  preserve(`${shortcodeRoot}.clips_music_attribution_info.should_mute_audio`, ['boolean']),
  opaque(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.id`, 'TAG_ID'),
  preserve(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.x`, ['number']),
  preserve(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.y`, ['number']),
  ...person(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.user`),
  preserve(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.user.followed_by_viewer`, [
    'boolean',
  ]),
  preserve(`${shortcodeRoot}.edge_media_to_tagged_user.edges[].node.user.is_verified`, ['boolean']),
];

const tray = 'tray[]';
const trayRules: ReadonlyArray<PolicyRule> = [
  preserve('highlights_tray_type'),
  preserve('status'),
  opaque('cursor', 'CURSOR'),
  preserve('has_fetched_all_remaining_highlights', ['boolean']),
  preserve('last_paginated_highlights_node_edited_at_ts', ['number']),
  entityField(`${tray}.id`, 'MEDIA', tray, 'ID', ['string', 'number'], 'MEDIA_ID'),
  entityField(`${tray}.strong_id__`, 'MEDIA', tray, 'ID', ['string', 'number'], 'MEDIA_ID'),
  entityField(`${tray}.title`, 'MEDIA', tray, 'TITLE'),
  preserve(`${tray}.can_gif_quick_reply`, ['boolean']),
  preserve(`${tray}.can_reply`, ['boolean']),
  preserve(`${tray}.can_reshare`, ['boolean']),
  preserve(`${tray}.can_react_with_avatar`, ['boolean']),
  preserve(`${tray}.contains_stitched_media_blocked_by_rm`, ['boolean']),
  preserve(`${tray}.is_archived`, ['boolean']),
  preserve(`${tray}.is_converted_to_clips`, ['boolean']),
  preserve(`${tray}.is_nux`, ['boolean']),
  preserve(`${tray}.is_pinned_highlight`, ['boolean']),
  preserve(`${tray}.created_at`, ['number']),
  preserve(`${tray}.highlight_reel_type`),
  preserve(`${tray}.latest_reel_media`, ['number']),
  preserve(`${tray}.media_count`, ['number']),
  preserve(`${tray}.prefetch_count`, ['number']),
  preserve(`${tray}.ranked_position`, ['number']),
  preserve(`${tray}.reel_type`),
  preserve(`${tray}.seen_ranked_position`, ['number']),
  preserve(`${tray}.updated_timestamp`, ['number']),
  entityField(
    `${tray}.cover_media.media_id`,
    'MEDIA',
    `${tray}.cover_media`,
    'ID',
    ['string', 'number'],
    'MEDIA_ID'
  ),
  entityField(
    `${tray}.cover_media.upload_id`,
    'MEDIA',
    `${tray}.cover_media`,
    'UPLOAD_ID',
    ['string', 'number'],
    'MEDIA_UPLOAD_ID'
  ),
  preserve(`${tray}.seen`, ['number']),
  preserve(`${tray}.highlight_pog_unseen`, ['boolean']),
  preserve(`${tray}.cover_media.crop_rect[]`, ['number']),
  url(`${tray}.cover_media.cropped_image_version.url`, 'COVER', 'MEDIA', `${tray}.cover_media`),
  preserve(`${tray}.cover_media.cropped_image_version.height`, ['number']),
  preserve(`${tray}.cover_media.cropped_image_version.width`, ['number']),
  preserve(`${tray}.cover_media.cropped_image_version.scans_profile`),
  ...person(`${tray}.user`),
  entityField(
    `${tray}.user.interop_messaging_user_fbid`,
    'PERSON',
    `${tray}.user`,
    'FB_ID',
    ['string', 'number'],
    'PERSON_FB'
  ),
  entityField(
    `${tray}.user.profile_pic_id`,
    'MEDIA',
    `${tray}.user`,
    'PROFILE_PICTURE_ID',
    ['string', 'number'],
    'MEDIA_ID'
  ),
  preserve(`${tray}.user.is_private`, ['boolean']),
  preserve(`${tray}.user.is_verified`, ['boolean']),
  preserve(`${tray}.user.is_creator_agent_enabled`, ['boolean']),
];

const profile = 'data.user';
const profileRules: ReadonlyArray<PolicyRule> = [
  preserve('status'),
  ...person(profile),
  entityField(`${profile}.fbid`, 'PERSON', profile, 'FB_ID', ['string', 'number'], 'PERSON_FB'),
  entityField(`${profile}.eimu_id`, 'PERSON', profile, 'EIMU_ID', ['string'], 'PERSON_EIMU'),
  url(`${profile}.profile_pic_url_hd`, 'PROFILE_PICTURE_HD', 'PERSON', profile),
  opaque(`${profile}.biography`, 'BIOGRAPHY'),
  opaque(`${profile}.biography_with_entities.raw_text`, 'BIOGRAPHY'),
  preserve(`${profile}.business_contact_method`),
  preserve(`${profile}.edge_follow.count`, ['number']),
  preserve(`${profile}.edge_followed_by.count`, ['number']),
  preserve(`${profile}.edge_mutual_followed_by.count`, ['number']),
  entityField(
    `${profile}.edge_mutual_followed_by.edges[].node.username`,
    'PERSON',
    `${profile}.edge_mutual_followed_by.edges[].node`,
    'USERNAME',
    ['string'],
    'PERSON_USERNAME'
  ),
  preserve(`${profile}.edge_owner_to_timeline_media.count`, ['number']),
  opaque(`${profile}.edge_owner_to_timeline_media.page_info.end_cursor`, 'CURSOR'),
  preserve(`${profile}.edge_owner_to_timeline_media.page_info.has_next_page`, ['boolean']),
  url(`${profile}.external_url`, 'EXTERNAL'),
  url(`${profile}.external_url_linkshimmed`, 'EXTERNAL_LINK_SHIM'),
  preserve(`${profile}.has_ar_effects`, ['boolean']),
  preserve(`${profile}.has_chaining`, ['boolean']),
  preserve(`${profile}.has_clips`, ['boolean']),
  preserve(`${profile}.highlight_reel_count`, ['number']),
  preserve(`${profile}.is_professional_account`, ['boolean']),
  preserve(`${profile}.is_verified`, ['boolean']),
  preserve(`${profile}.pinned_channels_list_count`, ['number']),
  preserve(`${profile}.show_account_transparency_details`, ['boolean']),
  preserve(`${profile}.blocked_by_viewer`, ['boolean']),
  preserve(`${profile}.restricted_by_viewer`, ['boolean']),
  preserve(`${profile}.country_block`, ['boolean']),
  preserve(`${profile}.followed_by_viewer`, ['boolean']),
  preserve(`${profile}.follows_viewer`, ['boolean']),
  preserve(`${profile}.has_guides`, ['boolean']),
  preserve(`${profile}.has_channel`, ['boolean']),
  preserve(`${profile}.has_blocked_viewer`, ['boolean']),
  preserve(`${profile}.has_requested_viewer`, ['boolean']),
  preserve(`${profile}.hide_like_and_view_counts`, ['boolean']),
  preserve(`${profile}.is_business_account`, ['boolean']),
  preserve(`${profile}.is_supervision_enabled`, ['boolean']),
  preserve(`${profile}.is_guardian_of_viewer`, ['boolean']),
  preserve(`${profile}.is_supervised_by_viewer`, ['boolean']),
  preserve(`${profile}.is_supervised_user`, ['boolean']),
  preserve(`${profile}.is_embeds_disabled`, ['boolean']),
  preserve(`${profile}.is_joined_recently`, ['boolean']),
  preserve(`${profile}.is_private`, ['boolean']),
  preserve(`${profile}.is_verified_by_mv4b`, ['boolean']),
  preserve(`${profile}.is_regulated_c18`, ['boolean']),
  preserve(`${profile}.requested_by_viewer`, ['boolean']),
  preserve(`${profile}.should_show_category`, ['boolean']),
  preserve(`${profile}.should_show_public_contacts`, ['boolean']),
  entityField(
    `${profile}.guardian_id`,
    'PERSON',
    `${profile}.guardian_id`,
    'GUARDIAN_ID',
    ['string', 'number'],
    'PERSON_IG'
  ),
  opaque(`${profile}.business_address_json`, 'BUSINESS_ADDRESS'),
  opaque(`${profile}.business_email`, 'BUSINESS_EMAIL'),
  opaque(`${profile}.business_phone_number`, 'BUSINESS_PHONE'),
  opaque(`${profile}.business_category_name`, 'BUSINESS_CATEGORY'),
  opaque(`${profile}.overall_category_name`, 'BUSINESS_CATEGORY'),
  opaque(`${profile}.category_enum`, 'BUSINESS_CATEGORY'),
  opaque(`${profile}.category_name`, 'BUSINESS_CATEGORY'),
  url(`${profile}.fb_profile_biolink`, 'PROFILE_BIO_LINK'),
  opaque(`${profile}.pronouns[]`, 'PRONOUN'),
  preserve(`${profile}.ai_agent_type`),
  opaque(`${profile}.transparency_label`, 'TRANSPARENCY_LABEL'),
  preserve(`${profile}.transparency_product`),
  preserve(`${profile}.bio_links[].link_type`),
  opaque(`${profile}.bio_links[].title`, 'BIO_LINK_TITLE'),
  url(`${profile}.bio_links[].url`, 'BIO_LINK'),
  url(`${profile}.bio_links[].lynx_url`, 'BIO_LINK_SHIM'),
];

const storyEmptyContainers: FixturePolicy['emptyContainers'] = [
  emptyArray('data.reels_media[].items[].overlay_image_resources'),
  emptyObject('data.reels_media[].items[].story_app_attribution'),
];

const shortcodeEmptyContainers: FixturePolicy['emptyContainers'] = [
  emptyObject(`${shortcodeRoot}.gating_info`),
  emptyObject(`${shortcodeRoot}.sensitivity_friction_info`),
  emptyObject(`${shortcodeRoot}.media_overlay_info`),
  emptyObject(`${shortcodeRoot}.upcoming_event`),
  emptyArray(`${shortcodeRoot}.edge_media_to_tagged_user.edges`),
  emptyArray(`${shortcodeRoot}.edge_media_to_comment.edges`),
  emptyArray(`${shortcodeRoot}.edge_media_to_sponsor_user.edges`),
  emptyObject(`${shortcodeRoot}.nft_asset_info`),
  emptyArray(`${shortcodeRoot}.edge_web_media_to_related_media.edges`),
  emptyArray(`${shortcodeRoot}.pinned_for_users`),
  emptyArray(`${shortcodeRoot}.edge_related_profiles.edges`),
];

const sidecarEmptyContainers: FixturePolicy['emptyContainers'] = [
  emptyObject(`${sidecarChild}.gating_info`),
  emptyObject(`${sidecarChild}.sensitivity_friction_info`),
  emptyObject(`${sidecarChild}.media_overlay_info`),
  emptyObject(`${sidecarChild}.upcoming_event`),
  emptyArray(`${sidecarChild}.edge_media_to_tagged_user.edges`),
];

const instantFeed = 'data.xdt_get_quick_snaps';
const instantItem = `${instantFeed}.items_ordered_by_time[]`;
const instantRules: ReadonlyArray<PolicyRule> = [
  preserve(`${instantItem}.__typename`),
  preserve(`${instantItem}.__is_XDTMediaDict`, ['boolean']),
  entityField(`${instantItem}.id`, 'MEDIA', instantItem, 'ID', ['string'], 'MEDIA_ID'),
  entityField(`${instantItem}.strong_id__`, 'MEDIA', instantItem, 'ID', ['string'], 'MEDIA_ID'),
  preserve(`${instantItem}.context__`),
  preserve(`${instantItem}.taken_at`, ['number']),
  preserve(`${instantItem}.media_type`, ['number']),
  preserve(`${instantItem}.source_type`, ['number']),
  preserve(`${instantItem}.audience`),
  preserve(`${instantItem}.caption.__typename`),
  opaque(`${instantItem}.caption.strong_id__`, 'CAPTION_ID'),
  opaque(`${instantItem}.caption.pk`, 'CAPTION_ID'),
  opaque(`${instantItem}.caption.text`, 'CAPTION'),
  ...person(`${instantItem}.user`),
  preserve(`${instantItem}.user.__typename`),
  preserve(`${instantItem}.user.__is_XDTUserDict`, ['boolean']),
  entityField(
    `${instantItem}.user.fbid_v2`,
    'PERSON',
    `${instantItem}.user`,
    'FB_ID',
    ['string', 'number'],
    'PERSON_FB'
  ),
  entityField(
    `${instantItem}.user.profile_pic_id`,
    'MEDIA',
    `${instantItem}.user`,
    'PROFILE_PICTURE_ID',
    ['string', 'number'],
    'MEDIA_ID'
  ),
  preserve(`${instantItem}.image_versions2.candidates[].width`, ['number']),
  preserve(`${instantItem}.image_versions2.candidates[].height`, ['number']),
  url(`${instantItem}.image_versions2.candidates[].url`, 'INSTANT_IMAGE', 'MEDIA', instantItem),
  preserve(`${instantItem}.image_versions2.candidates[].scans_profile`),
  preserve(`${instantItem}.video_versions[].width`, ['number']),
  preserve(`${instantItem}.video_versions[].height`, ['number']),
  preserve(`${instantItem}.video_versions[].type`, ['number']),
  opaque(`${instantItem}.video_versions[].id`, 'INSTANT_VIDEO_VERSION_ID'),
  url(`${instantItem}.video_versions[].url`, 'INSTANT_VIDEO', 'MEDIA', instantItem),
  opaque(`${instantItem}.video_dash_manifest`, 'DASH_MANIFEST'),
  preserve(`${instantItem}.video_duration`, ['number']),
  opaque(`${instantItem}.prompt_info.id`, 'INSTANT_PROMPT_ID'),
  opaque(`${instantItem}.prompt_info.text`, 'INSTANT_PROMPT'),
  opaque(`${instantItem}.quick_snap_info.filter_key`, 'INSTANT_FILTER'),
  opaque(`${instantItem}.wearable_attribution_info`, 'WEARABLE_ATTRIBUTION'),
  preserve(`${instantFeed}.latest_reaction_timestamp`, ['number']),
  opaque(`${instantFeed}.ranking_request_id`, 'RANKING_REQUEST'),
  preserve(`${instantFeed}.is_hidden`, ['boolean']),
  preserve(`${instantFeed}.has_unseen_from_top_bffs`, ['boolean']),
  opaque(`${instantFeed}.gtm_train_text`, 'PRESENTATION_TEXT'),
  opaque(`${instantFeed}.gtm_video_text`, 'PRESENTATION_TEXT'),
  opaque(`${instantFeed}.gtm_filters_text`, 'PRESENTATION_TEXT'),
  opaque(`${instantFeed}.gtm_recap_text`, 'PRESENTATION_TEXT'),
];

const instantEmptyContainers: FixturePolicy['emptyContainers'] = [
  emptyArray(`${instantFeed}.items_ordered_by_time`),
  emptyArray(`${instantFeed}.sample_items`),
  emptyObject(`${instantItem}.quick_snap_info`),
  emptyArray(`${instantItem}.user.account_badges`),
  emptyArray(`${instantItem}.video_versions`),
];

export const FIXTURE_POLICIES: Readonly<Record<FixtureFilename, FixturePolicy>> = {
  'avatar.json': {
    rules: [preserve('status')],
    emptyContainers: [emptyObject('user')],
  },
  'highlights-tray.json': {
    rules: trayRules,
    emptyContainers: [
      emptyObject('suggested_highlights'),
      emptyObject(`${tray}.cover_media.full_image_version`),
      emptyArray(`${tray}.user.account_badges`),
    ],
  },
  'highlights.json': {
    rules: [...reel('data.reels_media[]'), ...graphqlErrors],
    emptyContainers: storyEmptyContainers,
  },
  'instants-photo.json': { rules: instantRules, emptyContainers: instantEmptyContainers },
  'instants-video.json': { rules: instantRules, emptyContainers: instantEmptyContainers },
  'instants-empty.json': { rules: instantRules, emptyContainers: instantEmptyContainers },
  'shortcode-image.json': {
    rules: [...shortcodeCommon, ...graphqlErrors],
    emptyContainers: shortcodeEmptyContainers,
  },
  'shortcode-sidecar.json': {
    rules: [...sidecarRules, ...graphqlErrors],
    emptyContainers: [...shortcodeEmptyContainers, ...sidecarEmptyContainers],
  },
  'shortcode-video.json': {
    rules: [...videoRules, ...graphqlErrors],
    emptyContainers: shortcodeEmptyContainers,
  },
  'story.json': {
    rules: [...reel('data.reels_media[]'), ...graphqlErrors],
    emptyContainers: storyEmptyContainers,
  },
  'web-profile-info.json': {
    rules: profileRules,
    emptyContainers: [
      emptyArray(`${profile}.biography_with_entities.entities`),
      emptyObject(`${profile}.group_metadata`),
      emptyArray(`${profile}.edge_owner_to_timeline_media.edges`),
    ],
  },
};

export const isFixtureFilename = (value: string): value is FixtureFilename =>
  FIXTURE_FILENAMES.some(filename => filename === value);
