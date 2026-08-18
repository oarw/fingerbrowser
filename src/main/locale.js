const COUNTRY_LOCALES = Object.freeze({
  US: ['en-US', 'en-US,en'], GB: ['en-GB', 'en-GB,en'], AU: ['en-AU', 'en-AU,en'],
  CA: ['en-CA', 'en-CA,en,fr-CA,fr'], NZ: ['en-NZ', 'en-NZ,en'], IE: ['en-IE', 'en-IE,en'],
  CN: ['zh-CN', 'zh-CN,zh'], TW: ['zh-TW', 'zh-TW,zh'],
  HK: ['zh-HK', 'zh-HK,zh,en-HK,en'], SG: ['en-SG', 'en-SG,en,zh-SG,zh'],
  JP: ['ja-JP', 'ja-JP,ja'], KR: ['ko-KR', 'ko-KR,ko'],
  DE: ['de-DE', 'de-DE,de'], AT: ['de-AT', 'de-AT,de'],
  CH: ['de-CH', 'de-CH,de,fr-CH,fr,it-CH,it'], FR: ['fr-FR', 'fr-FR,fr'],
  BE: ['nl-BE', 'nl-BE,nl,fr-BE,fr'], ES: ['es-ES', 'es-ES,es'],
  MX: ['es-MX', 'es-MX,es'], AR: ['es-AR', 'es-AR,es'], CL: ['es-CL', 'es-CL,es'],
  CO: ['es-CO', 'es-CO,es'], IT: ['it-IT', 'it-IT,it'], PT: ['pt-PT', 'pt-PT,pt'],
  BR: ['pt-BR', 'pt-BR,pt'], RU: ['ru-RU', 'ru-RU,ru'], UA: ['uk-UA', 'uk-UA,uk'],
  PL: ['pl-PL', 'pl-PL,pl'], NL: ['nl-NL', 'nl-NL,nl'], SE: ['sv-SE', 'sv-SE,sv'],
  NO: ['nb-NO', 'nb-NO,nb'], DK: ['da-DK', 'da-DK,da'], FI: ['fi-FI', 'fi-FI,fi'],
  TR: ['tr-TR', 'tr-TR,tr'], TH: ['th-TH', 'th-TH,th'], VN: ['vi-VN', 'vi-VN,vi'],
  ID: ['id-ID', 'id-ID,id'], IN: ['en-IN', 'en-IN,en,hi-IN,hi'],
  MY: ['ms-MY', 'ms-MY,ms,en-MY,en'], PH: ['en-PH', 'en-PH,en,fil-PH,fil']
})

export function localeForCountry(countryCode) {
  const [language, acceptLanguages] = COUNTRY_LOCALES[String(countryCode || '').toUpperCase()] || [
    'en-US',
    'en-US,en'
  ]
  return { language, acceptLanguages }
}

