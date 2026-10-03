// Public entry for the Twelve Data provider. Register it explicitly:
//   import { TwelveDataProvider } from 'vela/providers/twelvedata';
//   chart.data.registerProvider('twelvedata', new TwelveDataProvider(apiKey));
export { TwelveDataProvider } from './TwelveDataProvider';
export type { SymbolDescriptor, ProviderInfo, DataProvider } from '../../../core/ports/DataProvider';
