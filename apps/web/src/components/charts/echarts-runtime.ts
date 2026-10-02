import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use as register } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

// This module is only imported after a drawable NeoChart is mounted.
register([
  BarChart,
  LineChart,
  PieChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);

export { init };
