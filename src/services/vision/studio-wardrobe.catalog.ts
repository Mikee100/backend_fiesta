/**
 * Studio Wardrobe Catalog for Fiesta House Maternity Atelier
 * Extracted directly from https://www.fiestahousematernity.com/maternity-gowns
 * and signature studio concepts.
 */

export interface StudioWardrobeItem {
  id: string;
  name: string;
  category: 'gown' | 'power_suit' | 'robe' | 'silk_wrap' | 'dress';
  colors: string[];
  keyFeatures: string[];
  includedAccessories?: string[];
  studioConfirmation: string;
}

export const STUDIO_WARDROBE_CATALOG: StudioWardrobeItem[] = [
  {
    id: 'champagne-gold-goddess-crown',
    name: 'Champagne Gold Goddess Draped Look & Handcrafted Crown',
    category: 'gown',
    colors: ['champagne', 'gold', 'amber', 'metallic', 'cream'],
    keyFeatures: [
      'sheer beaded champagne gold draped fabric',
      'handcrafted metallic or crystal goddess headpiece / crown / sunburst halo',
      'ethereal flowing goddess silhouette'
    ],
    includedAccessories: ['Handcrafted metallic sunburst/crystal headpiece crown', 'Draped silks'],
    studioConfirmation:
      'Yes! That is our signature Champagne Gold Goddess Draped Look with our handcrafted crown! ✨ It is one of our most requested in-house studio atelier looks and is available right in our studio wardrobe for your session.'
  },
  {
    id: 'fiesta-house-power-suit',
    name: 'Fiesta House Signature Power Suit',
    category: 'power_suit',
    colors: ['white', 'black', 'cream'],
    keyFeatures: [
      'structured sharp-shoulder tailored blazer',
      'matching tailored high-waisted trousers',
      'editorial bold empowered aesthetic'
    ],
    includedAccessories: ['Tailored blazer', 'Matching trousers'],
    studioConfirmation:
      'Yes! That is our iconic Fiesta House Power Suit! 🤍 Bold, tailored, and undeniably powerful. It is available right in our studio wardrobe (included with The Empress and The Goddess editions, or available as an add-on look).'
  },
  {
    id: 'white-power-bow-gloves',
    name: 'White Couture Gown with Statement Chest Bow & Opera Gloves',
    category: 'gown',
    colors: ['white', 'ivory', 'off-white'],
    keyFeatures: [
      'dramatic giant statement bow across the chest/bust',
      'matching white opera-length gloves',
      'clean minimalist high-fashion couture silhouette'
    ],
    includedAccessories: ['Statement chest bow', 'Matching white opera gloves'],
    studioConfirmation:
      'Yes! That is our signature White Couture Statement Bow Gown with matching opera gloves! ✨ It is part of our studio atelier collection and ready for your session.'
  },
  {
    id: 'royal-blue-butterfly-ruffle',
    name: 'Royal Blue Tiered Ruffle & Butterfly Wing Gown',
    category: 'gown',
    colors: ['royal blue', 'sapphire', 'electric blue'],
    keyFeatures: [
      'deep royal blue sheer textured ruffles',
      'statement butterfly-inspired wings / cape sleeves',
      'high-volume layered drama'
    ],
    includedAccessories: ['Matching textured butterfly wings / cape'],
    studioConfirmation:
      'Yes! That is our stunning Royal Blue Butterfly Ruffle Gown! ✨ A breathtaking, dramatic atelier piece available in our studio wardrobe for your session.'
  },
  {
    id: 'fuchsia-tiered-tulle-crown',
    name: 'Fuchsia Magenta Tiered Tulle Ballgown & Ornate Crown',
    category: 'gown',
    colors: ['fuchsia', 'magenta', 'hot pink', 'rose'],
    keyFeatures: [
      'giant multi-tiered ruffle tulle ballgown',
      'high-volume dramatic train and shoulder ruffles',
      'paired with ornate golden studio crown'
    ],
    includedAccessories: ['Ornate golden queen crown'],
    studioConfirmation:
      'Yes! That is our grand Fuchsia Magenta Tiered Tulle Ballgown! 🌸 Bold, vibrant, and royally voluminous, available in our studio wardrobe for your shoot.'
  },
  {
    id: 'red-velvet-high-slit',
    name: 'Scarlet Red High-Slit Gown with Flowing Train',
    category: 'gown',
    colors: ['red', 'scarlet', 'crimson'],
    keyFeatures: [
      'dramatic thigh-high slit showing bump and leg',
      'flowing red train that catches motion',
      'paired with our romantic red heart balloon concept set'
    ],
    includedAccessories: ['Heart balloon concept set pairing'],
    studioConfirmation:
      'Yes! That is our striking Scarlet Red High-Slit Gown! ❤️ A show-stopping romantic piece in our studio wardrobe, famously paired with our red concept sets.'
  },
  {
    id: 'caramel-bronze-tiered-tulle',
    name: 'Bronze Caramel Tiered Ruffle Tulle Gown',
    category: 'gown',
    colors: ['bronze', 'caramel', 'nude', 'warm brown', 'terracotta'],
    keyFeatures: [
      'warm bronze/caramel multi-tiered cascading tulle ruffles',
      'deep textured layers that catch studio rim light',
      'sculptural earthy elegance'
    ],
    studioConfirmation:
      'Yes! That is our warm Bronze Caramel Tiered Tulle Gown! ✨ Richly textured and flattering on all skin tones, available in our studio collection.'
  },
  {
    id: 'pastel-pink-sheer-swing-robe',
    name: 'Blush Pink Sheer Draped Robe & Floral Swing',
    category: 'robe',
    colors: ['blush pink', 'baby pink', 'pastel pink'],
    keyFeatures: [
      'ultra-sheer lightweight flowing pink fabric',
      'drapes gracefully across our hanging floral swing set',
      'romantic fairytale and ethereal aesthetic'
    ],
    includedAccessories: ['Floral swing concept setup'],
    studioConfirmation:
      'Yes! That is our delicate Blush Pink Sheer Draped Robe! 🌸 Soft, ethereal, and beautifully photographed on our hanging floral swing set.'
  },
  {
    id: 'golden-satin-silk-train',
    name: 'Mustard Gold Satin Flying Silk & Staircase Train',
    category: 'silk_wrap',
    colors: ['mustard', 'gold', 'yellow-gold', 'ochre'],
    keyFeatures: [
      'liquid satin gold fabric wrap',
      'meters-long flying silk train cascading down our architectural white stairs',
      'dramatic wind machine motion capture'
    ],
    studioConfirmation:
      'Yes! That is our iconic Mustard Gold Flying Silk! ✨ Cascades beautifully down our studio staircase with dramatic wind and motion, available in our studio wardrobe.'
  },
  {
    id: 'burgundy-rose-sunburst-crown',
    name: 'Deep Burgundy Velvet & Rose Gown with Sunburst Crown',
    category: 'gown',
    colors: ['burgundy', 'wine', 'maroon', 'deep red'],
    keyFeatures: [
      'luxurious deep wine/burgundy body-sculpting fabric',
      'paired with our studio golden sunburst halo crown',
      'rich jewel-tone elegance'
    ],
    includedAccessories: ['Golden sunburst halo crown'],
    studioConfirmation:
      'Yes! That is our Deep Burgundy Velvet Gown with the golden sunburst crown! ✨ A rich, regal studio favorite that photographs like fine art.'
  },
  {
    id: 'white-minimalist-off-shoulder',
    name: 'White Clean Drape Off-Shoulder Gown',
    category: 'gown',
    colors: ['white', 'ivory', 'cream'],
    keyFeatures: [
      'clean minimalist off-shoulder neckline',
      'softly sculpting the baby bump with floor-length drape',
      'timeless editorial simplicity'
    ],
    studioConfirmation:
      'Yes! That is our classic White Off-Shoulder Atelier Gown! 🤍 Timeless, clean, and elegant, available in our studio wardrobe.'
  }
];

/**
 * Returns formatted text description of the studio wardrobe catalog
 * to inject into the vision model system prompt.
 */
export function getStudioCatalogPromptSummary(): string {
  return STUDIO_WARDROBE_CATALOG.map((item) => {
    return `- ${item.name} (Colors: ${item.colors.join(', ')} | Features: ${item.keyFeatures.join(', ')})${
      item.includedAccessories ? ` [Accessories: ${item.includedAccessories.join(', ')}]` : ''
    }`;
  }).join('\n');
}
