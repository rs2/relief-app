import { registerPlugin } from '@capacitor/core';
import { exposeSynapse } from '@capacitor/synapse';
const Geolocation = registerPlugin('Geolocation', {
    web: () => import('./web.js').then((m) => new m.GeolocationWeb()),
});
exposeSynapse();
export * from './definitions.js';
export { Geolocation };
//# sourceMappingURL=index.js.map