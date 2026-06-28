/* ============================================================
   STAY transform — shared by importer, admin, and site.
   Turns a master-schema JSON (general.* + rooms/reviews/photos)
   into: (a) the admin state {property, pricing, units}
        (b) the site PROPERTY the template renders.
   Exposed as window.STAY.
   ============================================================ */
(function(){
  const RO={foodAndDrinks:"Mâncare & băutură",generalFacilities:"Facilități generale",wellness:"Wellness",exterior:"Exterior",cleaningServices:"Curățenie",businessFacilities:"Business",bathroom:"Baie",kitchen:"Bucătărie",bedroom:"Dormitor",comfort:"Confort & accesibilitate",commonAreas:"Zone comune",livingArea:"Zonă de zi",mediaTechnology:"Media & tehnologie",roomFacilities:"Facilitățile camerei",shops:"Magazine",skiing:"Schi",entertainmentAndFamilyServices:"Divertisment & familie",sportsAndRecreation:"Sport & recreere",receptionServices:"Recepție",servicesExtra:"Servicii extra",safety:"Siguranță",generalServices:"Servicii generale"};
  const FAC_CATS=["foodAndDrinks","generalFacilities","wellness","exterior","cleaningServices","businessFacilities","bathroom","kitchen","bedroom","comfort","commonAreas","livingArea","mediaTechnology","roomFacilities","shops"];
  const RULE_CATS={foodAndDrinks:1,generalFacilities:1,wellness:1,exterior:1,cleaningServices:1,businessFacilities:1};

  function slugify(s){return (s||"unitate").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60)||"unitate";}
  function nm(x){return typeof x==="string"?x:(x&&x.name)||"";}
  function take(a,n){return (a||[]).slice(0,n);}
  function icon(name){const s=(name||"").toLowerCase();
    const M=[
      ["piscin","pool"],["jacuzzi","jacuzzi"],["ciubăr","jacuzzi"],["ciubar","jacuzzi"],["cadă spa","jacuzzi"],["cada spa","jacuzzi"],["hot tub","jacuzzi"],["saun","sauna"],["masaj","massage"],["wellness","massage"],["spa","massage"],["fitness","fitness"],["sală de sport","fitness"],["sala de sport","fitness"],["sală de fitness","fitness"],
      ["semineu","fire"],["șemineu","fire"],["foc de tabără","fire"],["grătar","bbq"],["gratar","bbq"],["barbecue","bbq"],["bbq","bbq"],
      ["foișor","terrace"],["foisor","terrace"],["pavilion","terrace"],["teras","terrace"],["balcon","terrace"],["patio","terrace"],
      ["grădin","garden"],["gradin","garden"],["curte","garden"],
      ["parcare","parking"],["parc","parking"],
      ["wifi","wifi"],["internet","wifi"],
      ["aer condi","ac"],["climatiz","ac"],["aer condiţ","ac"],
      ["încălzire","heat"],["incalzire","heat"],["căldură","heat"],["radiator","heat"],
      ["lift","elevator"],["ascensor","elevator"],
      ["transfer","transfer"],["aeroport","transfer"],["shuttle","transfer"],
      ["mașină de spălat vase","dishwasher"],["maşină de spălat vase","dishwasher"],["spălat vase","dishwasher"],["spalat vase","dishwasher"],
      ["uscător de haine","dryer"],["uscător de rufe","dryer"],["uscator de haine","dryer"],
      ["mașină de spălat","washer"],["maşină de spălat","washer"],["spălat rufe","washer"],["spalat rufe","washer"],["mașină de spălat rufe","washer"],
      ["uscător de păr","hairdryer"],["uscator de par","hairdryer"],
      ["cuptor cu microunde","microwave"],["microunde","microwave"],["cuptor","oven"],
      ["plită","stove"],["plita","stove"],["aragaz","stove"],["gătit","stove"],["gatit","stove"],
      ["prăjitor","toaster"],["prajitor","toaster"],["toaster","toaster"],["toast","toaster"],
      ["fierbător","kettle"],["fierbator","kettle"],["cană fierbător","kettle"],["ceainic","kettle"],
      ["ustensile","utensils"],["tacâmuri","utensils"],["veselă","utensils"],["vesela","utensils"],["bucătărie","utensils"],["bucatarie","utensils"],["chicinetă","utensils"],["chicineta","utensils"],
      ["frigider","fridge"],["minibar","minibar"],
      ["mașină de cafea","coffee"],["maşină de cafea","coffee"],["aparat de cafea","coffee"],["aparat de preparat cafea","coffee"],["cafea","coffee"],["espressor","coffee"],["ceai","coffee"],
      ["cadă sau duș","bath"],["cadă","bath"],["cada","bath"],["duș","shower"],["dus","shower"],
      ["prosoape","towel"],["prosop","towel"],["lenjerie","towel"],
      ["articole de toaletă","toiletries"],["articole de toaleta","toiletries"],["papuci","toiletries"],["halat","toiletries"],
      ["toaletă suplim","bath"],["toaletă","bath"],["toaleta","bath"],["wc","bath"],["bideu","bath"],["baie","bath"],
      ["produse de curățenie","cleaning"],["curățenie","cleaning"],["curatenie","cleaning"],["menaj","cleaning"],
      ["scaun pentru copii","baby"],["scaun înalt","baby"],["scaun inalt","baby"],["bebel","baby"],["pătuț","baby"],["patut","baby"],
      ["loc de joacă","playground"],["loc de joaca","playground"],["joacă","playground"],["joaca","playground"],["copii","kids"],
      ["jocuri de societate","games"],["biliard","games"],["jocuri","games"],["joc","games"],
      ["restaurant","restaurant"],["bar","restaurant"],["mic dejun","restaurant"],
      ["televizor","tv"],["tv","tv"],["ecran plat","tv"],["smart tv","tv"],["netflix","tv"],
      ["proiector","projector"],
      ["recepț","key"],["recept","key"],["check-in","checkin"],["cheie","key"],
      ["schi","slope"],["pârtie","slope"],["partie","slope"],
      ["tenis","ball"],["badminton","ball"],["fotbal","ball"],["volei","ball"],["baschet","ball"],["sport","ball"],["teren de sport","ball"],
      ["izolare fonică","quiet"],["izolare fonica","quiet"],["liniște","quiet"],["liniste","quiet"],["petrecer","quiet"],
      ["fumat","smoke"],["nefumător","smoke"],["nefumator","smoke"],
      ["animal","pet"],
      ["pat","bed"],["dormitor","bed"],["canapea","lounge"],["living","lounge"],["zonă de zi","lounge"],["șezlong","lounge"],
      ["masă de luat masa","table"],["masă","table"],["masa","table"],
      ["vedere","view"],["priveliște","view"],["priveliste","view"],["vedere la munte","view"],["vedere la mare","view"],["vedere la lac","view"],
      ["munte","view"],["plajă","view"],["plaja","view"]
    ];
    for(const[k,v]of M)if(s.includes(k))return v; return "check";}

  /* ---- normalize master -> admin 'property' shape ---- */
  function normFacilities(af){const o={};FAC_CATS.forEach(c=>{let v=af[c];if(!Array.isArray(v))v=[];o[c]=v;});return o;}
  function normPolicies(p,cio){
    const ci=(cio.checkIn)||{},co=(cio.checkOut)||{};
    const eb=(p.extraBedAgeRates||[]).map(r=>({ageMin:(r.age&&r.age.min)??r.ageMin??0,ageMax:(r.age&&r.age.max)??r.ageMax??0,bedType:r.bedType||"",amount:(r.price&&r.price.amount)??r.amount??0,currency:(r.price&&r.price.currency)||r.currency||"RON",per:(r.price&&r.price.per)||r.per||""}));
    return {checkIn:{startHour:ci.startHour||"",endHour:ci.endHour||""},checkOut:{startHour:co.startHour||"",endHour:co.endHour||""},
      childrenPolicies:p.childrenPolicies||"",petsPolicy:p.petsPolicy||"",smokingPolicy:p.smokingUnitPolicy||p.smokingPolicy||"",parkingPolicy:p.parkingPolicy||"",internetPolicy:p.internetPolicy||"",mealPolicy:p.mealPolicy||"",noisePolicy:p.noisePolicy||"",partiesPolicy:p.partiesPolicy||"",groupsPolicy:p.groupsPolicy||"",ageRestriction:p.ageRestriction||"",damageDeposit:p.damageDeposit||"",extraBedAgeRates:eb};
  }
  function dist(a){return (a||[]).map(x=>({name:x.name||x.label||"",distance:x.distance??0})).filter(x=>x.name);}
  function normLocation(L){
    let slopes=[];(L.zones||[]).forEach(z=>{(z.slopes||[]).forEach(s=>slopes.push({name:s.name||s.label||nm(s),distance:s.distance??0}));});
    return {mainAttractions:dist(L.mainAttractions),nearbyAttractions:dist(L.nearbyAttractions),slopes:slopes.filter(s=>s.name),publicTransport:dist(L.publicTransport),nearbyAirports:dist(L.nearbyAirports)};
  }
  function photoUrl(p){const v=p&&(p.photoName||p.url||p.src||"");return (typeof v==="string"&&(/^https?:/.test(v)||/^data:image\//.test(v)))?v:"";}

  function deriveAdminState(m){
    const g=m.general||m, bi=g.basicInfo||{};
    const rooms=[],units=[],mr=m.rooms||[];
    if(mr.length){
      mr.forEach((r,i)=>{const id=slugify(r.roomName||("camera-"+(i+1)));const per=(r.periods&&r.periods[0])||{};
        rooms.push({id,name:r.roomName||("Cameră "+(i+1)),sub:"",weekday:+per.adult_week_price||496,weekend:+per.adult_weekend_price||+per.adult_week_price||496,currency:per.currency||"RON",minNights:+per.min_nights||1,isEntire:!!bi.entireUnitRental&&i===0,details:r.details||{}});
        units.push({id,feeds:[],blocks:[]});});
    }else{const id=slugify(bi.name||"unitate");rooms.push({id,name:bi.name||"Unitate",sub:bi.unitType||"",weekday:496,weekend:496,currency:"RON",minNights:1,isEntire:!!bi.entireUnitRental,details:{}});units.push({id,feeds:[],blocks:[]});}
    const property={
      basicInfo:{name:bi.name||"",unitType:bi.unitType||"",starRating:bi.starRating??null,entireUnitRental:!!bi.entireUnitRental,unitCapacity:bi.unitCapacity??null,roomsNumber:bi.roomsNumber??null,unitBathroomsNumber:bi.unitBathroomsNumber??null,unitSurface:bi.unitSurface||"",address:bi.address||"",county:bi.county||"",city:bi.city||"",locality:bi.locality||"",latitude:bi.latitude??null,longitude:bi.longitude??null},
      host:g.host||{hostName:"",hostImage:"",hostUnitDescription:"",spokenLanguages:[]},
      description:g.description||m.description||"",
      benefits:m.benefits||g.benefits||[],
      mostAppreciatedFacilities:g.mostAppreciatedFacilities||[],
      allFacilities:normFacilities(g.allFacilities||{}),
      activities:{skiing:(g.activities&&g.activities.skiing)||[],entertainmentAndFamilyServices:(g.activities&&g.activities.entertainmentAndFamilyServices)||[],sportsAndRecreation:(g.activities&&g.activities.sportsAndRecreation)||[]},
      services:{receptionServices:(g.services&&g.services.receptionServices)||[],servicesExtra:(g.services&&g.services.servicesExtra)||[],safety:(g.services&&g.services.safety)||[],generalServices:(g.services&&g.services.generalServices)||[]},
      policies:normPolicies(g.policies||{},g.checkInOut||{}),
      payment:{paymentMethods:(g.payment&&g.payment.paymentMethods)||[]},
      location:normLocation(g.location||{}),
      questionsAndAnswers:g.questionsAndAnswers||m.questionsAndAnswers||[],
      contact:m.contact||{name:bi.name||"",phone:"",email:"",website:""},
      _photos:(m.photos&&m.photos.generalPhotos)||[],
      _reviews:m.reviews||[], _reviewSummary:m.reviewSummary||{}
    };
    return {property,pricing:{rooms,periods:[]},units};
  }

  /* ---- admin property -> site PROPERTY (what the template renders) ---- */
  function masterToSite(P,pricing,galleries){
    const bi=P.basicInfo||{}, loc=P.location||{};
    const city=bi.city||bi.locality||"", county=bi.county?("jud. "+bi.county):"";
    const minPrice=Math.min.apply(null,((pricing&&pricing.rooms)||[{weekday:0}]).map(r=>r.weekday||0).filter(x=>x>0).concat([Infinity]));
    const photos=(P._photos||[]).map(photoUrl).filter(Boolean);
    const _gv=galleries||{};
    const _roomPhotos=rid=>((_gv[rid]||[]).map(p=>p&&p.url).filter(Boolean));
    const _allVariantPhotos=[]; ((pricing&&pricing.rooms)||[]).forEach(r=>_roomPhotos(r.id).forEach(u=>_allVariantPhotos.push(u)));
    const _entireRoom=((pricing&&pricing.rooms)||[]).find(r=>r.isEntire);
    const _entirePhotos=_entireRoom?_roomPhotos(_entireRoom.id):[];
    const _mainPool=[...new Set([].concat(photos,_entirePhotos,_allVariantPhotos))].filter(Boolean);
    const _hero=_mainPool[0]||"";
    const desc=P.description||(P.host&&P.host.hostUnitDescription)||"";
    const firstSentence=(desc.split(/(?<=[.!?])\s/)[0]||desc).slice(0,120);

    // overview features
    const features=[];
    if(bi.unitCapacity)features.push({icon:"guests",label:"Până la "+bi.unitCapacity+" oaspeți"});
    if(bi.entireUnitRental)features.push({icon:"key",label:"Închiriere integrală"});
    if(bi.roomsNumber)features.push({icon:"bed",label:bi.roomsNumber+" dormitoare"+(bi.unitBathroomsNumber?" · "+bi.unitBathroomsNumber+" băi":"")});
    take(P.mostAppreciatedFacilities,2).forEach(f=>features.push({icon:icon(nm(f)),label:nm(f)}));

    // flags
    const allNames=[].concat(...FAC_CATS.map(c=>(P.allFacilities[c]||[]).map(nm)),(P.activities.sportsAndRecreation||[]).map(nm),(P.activities.skiing||[]).map(nm)).join(" ").toLowerCase();
    const flags={pool:/piscin/.test(allNames),spa:/saun|spa|wellness|masaj/.test(allNames),ski:(P.location.slopes||[]).length>0||/schi|pârtie|partie/.test(allNames),forest:/pădure|padure|forest/.test((P.benefits||[]).join(" ").toLowerCase())};

    // spaces (curated feature-row groups)
    const grp=(title,arr)=>{const items=take(arr,6).map(x=>({icon:icon(nm(x)),title:nm(x),sub:""})).filter(i=>i.title);return items.length?{title,items}:null;};
    const spaces=[
      grp("Relaxare și exterior",[].concat(P.allFacilities.wellness||[],P.allFacilities.exterior||[])),
      grp("Confort și bucătărie",[].concat(P.allFacilities.kitchen||[],P.allFacilities.comfort||[])),
      grp("Socializare și distracție",[].concat(P.allFacilities.commonAreas||[],P.allFacilities.livingArea||[],P.activities.entertainmentAndFamilyServices||[])),
      grp("Media & tehnologie",P.allFacilities.mediaTechnology||[])
    ].filter(Boolean);

    // highlight: data-driven from REAL facilities (no invented pool/spa claims)
    const _well=(P.allFacilities.wellness||[]).map(nm).filter(Boolean);
    const _ext=(P.allFacilities.exterior||[]).map(nm).filter(Boolean);
    const _sport=(P.activities.sportsAndRecreation||[]).map(nm).filter(Boolean);
    const _ent=(P.activities.entertainmentAndFamilyServices||[]).map(nm).filter(Boolean);
    const _hImg=photos[2]||photos[1]||photos[0]||"";
    const _cand=[
      {names:_well, eyebrow:"Pentru relaxare", heading:(flags.pool?"Piscină, spa & wellness":"Spa & wellness"), text:"Centrul de wellness completează experiența cazării — relaxare după o zi petrecută afară."},
      {names:_ext, eyebrow:"În aer liber", heading:"Spațiu exterior & relaxare", text:"Spații exterioare pentru relaxare și timp petrecut împreună."},
      {names:_sport.concat(_ent), eyebrow:"Activități", heading:"Activități & recreere", text:"Opțiuni de petrecere a timpului pentru un sejur activ."}
    ];
    let highlight=null;
    for(const c of _cand){ if(c.names.length){ highlight={eyebrow:c.eyebrow,heading:c.heading,text:c.text,image:_hImg,features:take(c.names,4).map(n=>({icon:icon(n),label:n}))}; break; } }

    // amenities grid (full)
    const amenities=[];
    if(P.mostAppreciatedFacilities&&P.mostAppreciatedFacilities.length)
      amenities.push({icon:"view",title:"Cele mai apreciate",items:P.mostAppreciatedFacilities.map(f=>({name:nm(f),featured:!!f.premiumFacility,extra:false,offsite:false}))});
    FAC_CATS.forEach(c=>{const list=P.allFacilities[c]||[];if(!list.length)return;
      amenities.push({icon:icon(RO[c])==="view"?"view":icon(RO[c]),title:RO[c],items:list.map(x=>({name:nm(x),featured:false,extra:!!(x&&x.priceRule),offsite:!!(x&&x.locationRule)}))});});
    ["skiing","entertainmentAndFamilyServices","sportsAndRecreation"].forEach(c=>{const list=P.activities[c]||[];if(!list.length)return;amenities.push({icon:c==="skiing"?"slope":"ball",title:RO[c],items:list.map(x=>({name:nm(x),featured:false,extra:!!(x&&x.priceRule),offsite:!!(x&&x.locationRule)}))});});
    ["receptionServices","safety","generalServices","servicesExtra"].forEach(c=>{const list=P.services[c]||[];if(!list.length)return;amenities.push({icon:"key",title:RO[c],items:list.map(x=>({name:nm(x),featured:false,extra:!!(x&&x.priceRule),offsite:!!(x&&x.locationRule)}))});});

    // rules from policies
    const po=P.policies||{}, rules=[];
    if(po.checkIn&&po.checkIn.startHour)rules.push({icon:"checkin",label:"Check-in"+(po.checkIn.endHour?" între "+po.checkIn.startHour+" și "+po.checkIn.endHour:" de la "+po.checkIn.startHour)});
    if(po.checkOut&&po.checkOut.startHour)rules.push({icon:"checkout",label:"Check-out"+(po.checkOut.endHour?" până la "+po.checkOut.endHour:" la "+po.checkOut.startHour)});
    if(bi.unitCapacity)rules.push({icon:"guests",label:"Număr maxim de persoane: "+bi.unitCapacity});
    if(po.smokingPolicy)rules.push({icon:"smoke",label:po.smokingPolicy});
    if(po.petsPolicy)rules.push({icon:"pet",label:po.petsPolicy});
    if(po.noisePolicy||po.partiesPolicy)rules.push({icon:"quiet",label:po.partiesPolicy||po.noisePolicy});

    // about
    const about=[];
    if(bi.unitType)about.push({label:"Tip proprietate",value:bi.unitType+(bi.entireUnitRental?" · închiriere integrală":"")});
    if(bi.unitCapacity)about.push({label:"Capacitate",value:"Până la "+bi.unitCapacity+" oaspeți"});
    if(bi.roomsNumber)about.push({label:"Dormitoare",value:bi.roomsNumber});
    if(bi.unitBathroomsNumber)about.push({label:"Băi",value:bi.unitBathroomsNumber});
    if(bi.unitSurface)about.push({label:"Suprafață",value:bi.unitSurface});
    if(_well.length)about.push({label:"Wellness",value:take(_well,3).join(", ")});
    if(city)about.push({label:"Localizare",value:[bi.locality,city].filter(Boolean).join(", ")});
    if(po.parkingPolicy)about.push({label:"Parcare",value:po.parkingPolicy});

    // reviews
    const rs=P._reviewSummary||{}, ritems=(P._reviews||[]).map(r=>({name:(r.clientInfo&&(r.clientInfo.name||r.clientInfo.country))?("Oaspete · "+(r.clientInfo.country||r.clientInfo.name)):"Oaspete",meta:r.title||"",rating:Math.round(r.reviewRating||5),text:r.body||""})).filter(r=>r.text);
    const reviews=ritems.length?{average:rs.generalRating?+rs.generalRating:null,count:rs.reviewCount||ritems.length,items:ritems}:null;

    // faq (wrap flat Q&A into one category)
    const qa=(P.questionsAndAnswers||[]).map(x=>({q:x.question||"",a:x.answer||""})).filter(x=>x.q);
    const faq=qa.length?[{category:"Întrebări frecvente",items:qa}]:[];

    // galleries from photos
    const mainGalleries=_mainPool.length>=2?[{heading:"Galerie foto",slides:_mainPool.map((u)=>({img:u,cap:""}))}]:[];

    // dedicated Activities + Services sections (grouped, real data only)
    const mkItem=x=>({name:nm(x),extra:!!(x&&x.priceRule),offsite:!!(x&&x.locationRule)});
    const mkGroups=(src,defs)=>defs.map(d=>{const items=(src[d[0]]||[]).map(mkItem).filter(i=>i.name);return items.length?{title:d[1],items}:null;}).filter(Boolean);
    const activitiesView=mkGroups(P.activities||{},[["skiing","Schi"],["sportsAndRecreation","Sport & recreere"],["entertainmentAndFamilyServices","Divertisment & familie"]]);
    const servicesView=mkGroups(P.services||{},[["receptionServices","Recepție"],["generalServices","Servicii generale"],["servicesExtra","Servicii extra"],["safety","Siguranță"]]);

    return {
      activities:activitiesView, services:servicesView,
      name:bi.name||"",
      tagline:(firstSentence&&firstSentence.length<=70)?firstSentence:((bi.unitType||"Cazare")+(flags.pool?" cu piscină și spa":(flags.ski?" la munte":""))+(city?" în "+city:"")),
      intro:desc.slice(0,240),
      location:{area:city,county,note:bi.locality||"",address:bi.address||"",lat:bi.latitude,lng:bi.longitude},
      priceFrom:(isFinite(minPrice)&&minPrice>0)?{amount:minPrice,currency:(pricing.rooms[0]&&pricing.rooms[0].currency)||"RON",unit:"noapte"}:null,
      photos:{hero:_hero,strip:take(_mainPool,5)},
      overview:{image:_mainPool[1]||_mainPool[0]||"",heading:((bi.unitType||"Cazare")+(flags.pool?" cu piscină și spa":"")+(city?" în "+city:"")),description:desc,features},
      flags, galleries:mainGalleries, spaces, highlight, amenities, rules,
      entireUnitRental:!!bi.entireUnitRental,
      rentals:((pricing&&pricing.rooms)||[]).map(r=>{
        const d=r.details||{};
        const beds=(d.spaces||[]).flatMap(sp=>((sp.spaceType&&sp.spaceType.beds)||[]));
        const bm={}; beds.forEach(b=>{const t=b.type||"pat";bm[t]=(bm[t]||0)+(+b.count||1);});
        const bedsTxt=Object.keys(bm).map(t=>bm[t]+" "+t).join(", ");
        return {id:r.id,name:r.name,sub:r.sub||"",weekday:+r.weekday||0,weekend:+r.weekend||+r.weekday||0,currency:r.currency||"RON",minNights:+r.minNights||1,isEntire:!!r.isEntire,
          capacity:d.adultsRoomCapacity||null,children:+d.childrenRoomCapacity||0,surface:d.surface||"",bathrooms:d.bathroomsNumber||null,
          bedrooms:((d.spaces||[]).length||d.spacesNumber||null),beds:bedsTxt,view:d.view||[],description:d.roomDescription||"",
          facilities:[].concat(d.keyFacilities||[],d.unitFacilities||[],d.bathroomFacilities||[],d.kitchenFacilities||[]),
          gallery:(_gv[r.id]||[]).map(p=>({url:p.url,thumb:p.thumb||p.url,alt:p.alt||""})).filter(p=>p.url)};
      }),
      capacity:bi.unitCapacity||null, roomsNumber:bi.roomsNumber||null, surface:bi.unitSurface||"",
      reviews:reviews||{items:[]}, faq, about,
      pricing:{ periods:((pricing&&pricing.periods)||[]).map(p=>({roomId:p.roomId||"all",start:p.start||"",end:p.end||"",weekday:+p.weekday||0,weekend:+p.weekend||+p.weekday||0,label:p.label||""})), dayPrices:(pricing&&pricing.dayPrices)||{} },
      _contact:P.contact||{}
    };
  }

  const STAY={slugify,deriveAdminState,masterToSite};
  if(typeof module!=="undefined"&&module.exports) module.exports={STAY};
  if(typeof window!=="undefined") window.STAY=STAY;
})();
