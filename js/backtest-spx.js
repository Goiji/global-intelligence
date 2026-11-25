(function(){
  const BT_DATA = {"start":"1990-01","va":[23.3,23.3,20.1,21.4,18.1,16.8,18.4,28.2,29.1,29.6,24.9,23.4,27.4,21.6,17.7,17.4,16.9,17.1,17.3,15.7,17.0,16.4,17.8,18.3,17.7,17.5,17.5,16.6,15.1,15.2,13.6,14.4,13.7,17.6,14.4,12.2,12.4,13.7,13.6,12.8,13.6,12.5,11.5,11.9,12.9,11.9,14.1,11.4,11.3,13.6,15.2,16.5,13.9,13.4,12.5,11.9,13.2,15.2,16.4,14.2,12.3,11.5,12.2,12.4,12.3,11.9,12.5,12.8,12.1,14.4,12.5,11.7,13.5,15.0,17.8,16.6,16.1,16.4,18.0,15.8,16.6,16.4,16.0,19.3,19.5,20.1,20.2,19.7,19.9,20.2,20.5,23.1,23.8,23.9,32.2,26.3,23.9,20.0,20.2,22.0,20.9,21.7,19.9,31.6,38.2,36.6,26.2,25.5,28.0,28.8,25.3,23.5,26.2,23.6,21.0,24.3,24.5,24.0,21.8,22.2,23.2,23.6,22.7,27.2,26.4,21.5,19.9,18.1,19.7,25.2,26.4,26.5,24.9,23.4,28.5,28.1,22.9,20.9,22.3,21.9,35.1,32.7,26.6,23.7,22.3,22.9,19.0,19.9,20.1,25.3,34.0,33.7,37.6,35.2,28.2,28.2,27.4,32.2,30.6,24.0,20.2,20.4,19.2,19.3,19.5,18.0,17.4,16.8,16.1,16.0,17.7,15.7,17.7,15.3,15.5,16.7,14.1,15.0,13.6,12.5,13.4,11.7,13.1,14.5,14.0,11.9,11.0,13.0,12.6,14.9,12.1,11.3,12.0,12.5,11.7,11.8,14.5,16.9,15.3,13.4,12.2,11.3,10.8,11.0,11.0,11.2,15.2,12.9,13.3,14.9,17.3,25.0,22.2,19.1,25.6,21.7,25.8,25.5,27.1,21.6,18.3,22.1,24.3,20.7,30.2,61.2,62.7,52.4,44.7,45.6,44.8,38.1,32.0,29.1,26.2,25.3,24.9,24.3,23.8,21.2,20.6,22.5,17.8,17.4,31.9,29.9,25.6,24.7,22.5,20.4,20.1,17.6,17.3,17.4,20.7,16.2,16.9,19.2,19.2,35.0,36.5,32.8,31.9,25.0,20.2,18.4,16.2,17.8,21.0,21.1,17.6,15.7,15.3,16.3,16.7,17.3,13.5,14.1,13.0,14.0,13.5,17.3,14.0,14.2,14.7,15.4,12.9,14.2,14.2,15.5,14.8,14.2,12.5,11.5,12.3,13.5,13.5,18.1,13.4,16.3,19.1,15.9,14.8,13.5,13.3,14.3,14.4,19.4,24.4,16.8,16.2,18.0,23.7,22.5,15.8,14.3,14.9,17.8,13.2,12.4,14.2,14.6,15.2,12.5,11.6,11.5,11.9,13.1,10.9,10.5,10.3,12.0,10.4,10.1,10.5,10.3,11.1,22.5,19.0,18.3,14.1,13.7,13.1,12.5,12.9,19.4,19.4,25.0,19.6,15.2,14.5,12.9,16.7,15.8,13.3,19.0,15.6,15.5,12.5,13.8,13.9,19.6,57.7,41.5,30.9,31.1,26.8,22.9,27.6,29.4,25.0,22.4,24.9,23.1,21.8,17.4,19.8,17.0,17.6,17.5,19.8,17.9,18.5,21.4,23.2,25.7,27.0,24.4,29.3,28.2,25.0,22.2,27.3,30.0,23.3,21.8,20.2,20.1,21.6,17.8,17.6,14.0,13.9,15.9,15.2,18.9,14.0,12.7,13.4,14.0,13.8,16.1,13.1,12.7,14.4,19.3,17.7,20.0,16.0,15.9,16.8,17.0,21.8,32.0,20.5,18.4,16.4,15.8,15.8,18.1,19.8,15.5,16.2,19.2,25.6,19.8,17.2,17.9,17.1,15.2,15.8,16.9,22.0],"vm":[27.3,24.9,22.7,24.2,20.1,19.4,23.7,36.5,30.6,34.0,30.9,26.4,36.2,23.6,21.1,20.1,18.4,19.6,20.3,21.2,18.2,18.6,21.9,20.6,19.2,18.8,19.8,20.1,16.9,18.2,15.8,16.2,15.2,21.0,17.3,12.8,14.7,15.9,16.2,15.3,14.8,14.7,13.9,12.4,17.3,13.1,15.9,13.8,12.6,16.0,20.4,23.9,16.2,16.7,14.9,12.8,14.6,17.0,18.4,18.1,14.3,12.5,14.2,13.5,13.1,13.4,13.5,13.8,13.2,15.7,13.4,14.6,16.4,17.0,20.7,20.2,18.6,18.6,21.6,18.8,20.5,18.5,18.0,22.0,21.1,21.4,22.1,21.3,21.6,21.8,23.5,24.8,26.0,38.2,37.8,30.3,28.7,21.6,24.7,26.1,23.4,25.9,25.3,44.3,45.3,45.7,29.3,31.3,33.0,31.4,29.2,26.4,28.9,26.6,25.0,28.4,27.8,28.8,24.2,24.8,27.0,26.0,25.5,33.5,31.6,23.1,21.2,20.6,21.9,30.5,29.6,31.7,30.0,28.4,32.8,34.7,25.8,23.2,25.2,25.4,43.7,35.3,32.3,25.9,24.4,26.1,20.5,24.1,22.6,28.4,44.9,45.1,40.6,42.6,31.4,30.8,34.7,34.3,33.6,29.1,21.6,22.1,20.2,22.7,22.7,21.1,19.5,18.3,18.2,17.9,21.6,17.3,20.0,17.0,17.3,19.3,14.9,16.6,16.3,13.7,14.7,13.1,14.5,17.7,16.3,12.7,12.5,14.2,13.8,16.5,14.8,12.2,14.6,13.6,12.7,13.0,18.7,23.8,18.6,15.2,13.9,12.6,12.3,12.7,12.1,18.3,19.6,14.5,14.1,18.9,24.2,30.8,27.4,23.0,31.1,24.5,31.0,29.0,32.2,23.8,19.7,24.1,28.5,23.5,46.7,80.1,80.9,68.5,56.6,52.6,52.6,42.3,35.3,32.7,31.3,27.9,29.1,30.7,29.8,23.7,27.3,26.5,19.3,22.8,45.8,36.6,32.9,27.5,23.9,23.5,23.5,21.4,20.0,22.1,29.4,17.9,18.4,22.7,25.3,48.0,43.0,45.5,36.2,30.6,23.0,21.1,20.9,20.4,25.1,26.7,20.5,19.0,18.0,18.8,19.1,22.7,14.7,19.0,15.4,17.6,16.3,20.5,16.4,17.0,16.6,20.3,13.9,16.2,18.4,21.4,17.8,17.0,13.8,12.7,16.9,17.0,16.3,26.3,14.9,23.6,22.4,19.4,16.9,15.1,15.2,18.9,20.0,40.7,31.4,22.6,20.1,24.4,27.6,28.1,18.7,16.3,16.3,25.8,15.6,13.7,18.1,17.1,22.5,14.1,12.8,12.9,13.1,16.0,15.6,11.5,12.5,16.0,12.2,11.3,13.1,11.7,14.8,37.3,24.9,23.6,17.0,17.9,16.1,14.8,14.9,25.2,22.5,36.1,25.4,16.4,16.6,14.3,20.6,18.9,16.1,24.6,19.7,20.6,13.1,16.0,18.8,40.1,82.7,57.1,37.2,40.8,32.2,26.4,33.6,40.3,37.1,25.2,37.2,30.2,28.6,18.7,27.6,20.7,22.5,21.7,25.7,23.0,28.6,31.1,32.0,31.0,36.5,33.5,34.8,34.0,27.5,26.2,32.6,33.6,26.1,25.0,22.9,22.9,26.5,19.1,20.1,15.7,15.4,17.9,18.9,21.7,16.9,13.7,14.8,15.8,15.2,19.2,15.4,13.3,18.5,38.6,22.4,23.2,22.0,27.6,19.5,21.1,27.9,52.3,24.8,22.2,17.8,20.4,17.2,25.3,26.4,17.6,20.1,21.8,31.1,25.8,18.4,22.2,20.7,16.5,17.8,20.0,28.4],"spx":[329.1,331.9,339.9,330.8,361.2,358.0,356.1,322.6,306.0,304.0,322.2,330.2,343.9,367.1,375.2,375.3,389.8,371.2,387.8,395.4,387.9,392.5,375.2,417.1,408.8,412.7,403.7,415.0,415.4,408.1,424.2,414.0,417.8,418.7,431.4,435.7,438.8,443.4,451.7,440.2,450.2,450.5,448.1,463.6,458.9,467.8,461.8,466.5,481.6,467.1,445.8,450.9,456.5,444.3,458.3,475.5,462.7,472.4,453.7,459.3,470.4,487.4,500.7,514.7,533.4,544.8,562.1,561.9,584.4,581.5,605.4,615.9,636.0,640.4,645.5,654.2,669.1,670.6,640.0,652.0,687.3,705.3,757.0,740.7,786.2,790.8,757.1,801.3,848.3,885.1,954.3,899.5,947.3,914.6,955.4,970.4,980.3,1049.3,1101.8,1111.8,1090.8,1133.8,1120.7,957.3,1017.0,1098.7,1163.6,1229.2,1279.6,1238.3,1286.4,1335.2,1301.8,1372.7,1328.7,1320.4,1282.7,1362.9,1388.9,1469.3,1394.5,1366.4,1498.6,1452.4,1420.6,1454.6,1430.8,1517.7,1436.5,1429.4,1314.9,1320.3,1366.0,1239.9,1160.3,1249.5,1255.8,1224.4,1211.2,1133.6,1040.9,1059.8,1139.4,1148.1,1130.2,1106.7,1147.4,1076.9,1067.1,989.8,911.6,916.1,815.3,885.8,936.3,879.8,855.7,841.2,848.2,916.9,963.6,974.5,990.3,1008.0,996.0,1050.7,1058.2,1111.9,1131.1,1144.9,1126.2,1107.3,1120.7,1140.8,1101.7,1104.2,1114.6,1130.2,1173.8,1211.9,1181.3,1203.6,1180.6,1156.8,1191.5,1191.3,1234.2,1220.3,1228.8,1207.0,1249.5,1248.3,1280.1,1280.7,1294.9,1310.6,1270.1,1270.2,1276.7,1303.8,1335.8,1377.9,1400.6,1418.3,1438.2,1406.8,1420.9,1482.4,1530.6,1503.3,1455.3,1474.0,1526.8,1549.4,1481.1,1468.4,1378.6,1330.6,1322.7,1385.6,1400.4,1280.0,1267.4,1282.8,1166.4,968.8,896.2,903.3,825.9,735.1,797.9,872.8,919.1,919.3,987.5,1020.6,1057.1,1036.2,1095.6,1115.1,1073.9,1104.5,1169.4,1186.7,1089.4,1030.7,1101.6,1049.3,1141.2,1183.3,1180.6,1257.6,1286.1,1327.2,1325.8,1363.6,1345.2,1320.6,1292.3,1218.9,1131.4,1253.3,1247.0,1257.6,1312.4,1365.7,1408.5,1397.9,1310.3,1362.2,1379.3,1406.6,1440.7,1412.2,1416.2,1426.2,1498.1,1514.7,1569.2,1597.6,1630.7,1606.3,1685.7,1633.0,1681.6,1756.5,1805.8,1848.4,1782.6,1859.4,1872.3,1883.9,1923.6,1960.2,1930.7,2003.4,1972.3,2018.1,2067.6,2058.9,1995.0,2104.5,2067.9,2085.5,2107.4,2063.1,2103.8,1972.2,1920.0,2079.4,2080.4,2043.9,1940.2,1932.2,2059.7,2065.3,2096.9,2098.9,2173.6,2170.9,2168.3,2126.1,2198.8,2238.8,2278.9,2363.6,2362.7,2384.2,2411.8,2423.4,2470.3,2471.6,2519.4,2575.3,2647.6,2673.6,2823.8,2713.8,2640.9,2648.1,2705.3,2718.4,2816.3,2901.5,2914.0,2711.7,2760.2,2506.9,2704.1,2784.5,2834.4,2945.8,2752.1,2941.8,2980.4,2926.5,2976.7,3037.6,3141.0,3230.8,3225.5,2954.2,2584.6,2912.4,3044.3,3100.3,3271.1,3500.3,3363.0,3270.0,3621.6,3756.1,3714.2,3811.1,3972.9,4181.2,4204.1,4297.5,4395.3,4522.7,4307.5,4605.4,4567.0,4766.2,4515.5,4373.9,4530.4,4131.9,4132.1,3785.4,4130.3,3955.0,3585.6,3872.0,4080.1,3839.5,4076.6,3970.1,4109.3,4169.5,4179.8,4450.4,4589.0,4507.7,4288.0,4193.8,4567.8,4769.8,4845.6,5096.3,5254.4,5035.7,5277.5,5460.5,5522.3,5648.4,5762.5,5705.5,6032.4,5881.6,6040.5,5954.5,5611.9,5569.1,5911.7,6205.0,6339.4,6460.3,6688.5,6840.2,6849.1,6845.5,6939.0,6878.9,6528.5,7209.0,7580.1,7499.4,7489.7,7686.1,7651.5,7580.1,6910.4],"ur":[5.4,5.3,5.2,5.4,5.4,5.2,5.5,5.7,5.9,5.9,6.2,6.3,6.4,6.6,6.8,6.7,6.9,6.9,6.8,6.9,6.9,7.0,7.0,7.3,7.3,7.4,7.4,7.4,7.6,7.8,7.7,7.6,7.6,7.3,7.4,7.4,7.3,7.1,7.0,7.1,7.1,7.0,6.9,6.8,6.7,6.8,6.6,6.5,6.6,6.6,6.5,6.4,6.1,6.1,6.1,6.0,5.9,5.8,5.6,5.5,5.6,5.4,5.4,5.8,5.6,5.6,5.7,5.7,5.6,5.5,5.6,5.6,5.6,5.5,5.5,5.6,5.6,5.3,5.5,5.1,5.2,5.2,5.4,5.4,5.3,5.2,5.2,5.1,4.9,5.0,4.9,4.8,4.9,4.7,4.6,4.7,4.6,4.6,4.7,4.3,4.4,4.5,4.5,4.5,4.6,4.5,4.4,4.4,4.3,4.4,4.2,4.3,4.2,4.3,4.3,4.2,4.2,4.1,4.1,4.0,4.0,4.1,4.0,3.8,4.0,4.0,4.0,4.1,3.9,3.9,3.9,3.9,4.2,4.2,4.3,4.4,4.3,4.5,4.6,4.9,5.0,5.3,5.5,5.7,5.7,5.7,5.7,5.9,5.8,5.8,5.8,5.7,5.7,5.7,5.9,6.0,5.8,5.9,5.9,6.0,6.1,6.3,6.2,6.1,6.1,6.0,5.8,5.7,5.7,5.6,5.8,5.6,5.6,5.6,5.5,5.4,5.4,5.5,5.4,5.4,5.3,5.4,5.2,5.2,5.1,5.0,5.0,4.9,5.0,5.0,5.0,4.9,4.7,4.8,4.7,4.7,4.6,4.6,4.7,4.7,4.5,4.4,4.5,4.4,4.6,4.5,4.4,4.5,4.4,4.6,4.7,4.6,4.7,4.7,4.7,5.0,5.0,4.9,5.1,5.0,5.4,5.6,5.8,6.1,6.1,6.5,6.8,7.3,7.8,8.3,8.7,9.0,9.4,9.5,9.5,9.6,9.8,10.0,9.9,9.9,9.8,9.8,9.9,9.9,9.6,9.4,9.4,9.5,9.5,9.4,9.8,9.3,9.1,9.0,9.0,9.1,9.0,9.1,9.0,9.0,9.0,8.8,8.6,8.5,8.3,8.3,8.2,8.2,8.2,8.2,8.2,8.1,7.8,7.8,7.7,7.9,8.0,7.7,7.5,7.6,7.5,7.5,7.3,7.2,7.2,7.2,6.9,6.7,6.6,6.7,6.7,6.2,6.3,6.1,6.2,6.1,5.9,5.7,5.8,5.6,5.7,5.5,5.4,5.4,5.6,5.3,5.2,5.1,5.0,5.0,5.1,5.0,4.8,4.9,5.0,5.1,4.8,4.9,4.8,4.9,5.0,4.9,4.7,4.7,4.7,4.6,4.4,4.4,4.4,4.3,4.3,4.4,4.3,4.2,4.2,4.1,4.0,4.1,4.0,4.0,3.8,4.0,3.8,3.8,3.7,3.8,3.8,3.9,4.0,3.8,3.8,3.7,3.6,3.6,3.7,3.6,3.5,3.6,3.6,3.6,3.6,3.5,4.4,14.8,13.2,11.0,10.2,8.4,7.8,6.9,6.7,6.7,6.4,6.2,6.1,6.1,5.8,5.9,5.4,5.1,4.7,4.5,4.1,3.9,4.0,3.9,3.7,3.7,3.6,3.6,3.5,3.6,3.5,3.6,3.6,3.5,3.5,3.6,3.5,3.4,3.6,3.6,3.5,3.7,3.7,3.9,3.7,3.8,3.7,3.9,3.9,3.9,3.9,4.1,4.2,4.2,4.1,4.1,4.2,4.1,4.0,4.2,4.2,4.2,4.3,4.1,4.3,4.3,4.4,null,4.5,4.4,4.3,4.4,4.3,4.3,4.3,4.2,4.1,4.1,4.2,4.1]};
  const BT_CRISES = [
    { id: 'dotcom', th: 'ฟองสบู่ดอทคอม', en: 'Dot-com bust', from: '2000-01', to: '2003-03' },
    { id: 'gfc', th: 'วิกฤตการเงินโลก', en: 'Global financial crisis', from: '2007-07', to: '2009-06' },
    { id: 'covid', th: 'โควิด', en: 'COVID crash', from: '2020-01', to: '2020-06' },
    { id: 'y2022', th: 'ดอกเบี้ยขึ้นแรง 2022', en: '2022 rate shock', from: '2021-12', to: '2022-12' }
  ];
  const ZONES = [[0, 15], [15, 20], [20, 25], [25, 30], [30, 40], [40, Infinity]];

  function btStats(d, crises){
    const px = d.spx, va = d.va, vm = d.vm, ur = d.ur, n = px.length;
    const y0 = +d.start.slice(0, 4), m0 = +d.start.slice(5, 7);
    const idx = s => (+s.slice(0, 4) - y0) * 12 + (+s.slice(5, 7) - m0);
    const label = i => { const t = y0 * 12 + m0 - 1 + i; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); };
    // the last month is still running, so it never counts as a finished 'later' point
    const fwd = (i, h) => i + h < n - 1 ? px[i + h] / px[i] - 1 : null;
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const median = a => { const b = a.slice().sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
    const inCrisis = new Set();
    const rows = crises.map(c => {
      const a = idx(c.from), b = idx(c.to);
      let p = a; for(let i = a; i <= b; i++) if(px[i] > px[p]) p = i;
      let t = p; for(let i = p; i <= b; i++) if(px[i] < px[t]) t = i;
      for(let i = p; i <= t; i++) inCrisis.add(i);
      let rec = null; for(let i = t; i < n; i++) if(px[i] >= px[p]){ rec = i; break; }
      let uPk = p; for(let i = p; i <= Math.min(n - 1, t + 24); i++) if(ur[i] != null && ur[i] > ur[uPk]) uPk = i;
      return { id: c.id, th: c.th, en: c.en, peak: label(p), trough: label(t), months: t - p,
        drawdown: px[t] / px[p] - 1, vixAvg: mean(va.slice(p, t + 1)), vixMax: Math.max.apply(null, vm.slice(p, t + 1)),
        vixAtPeak: va[p], urStart: ur[p], urMax: ur[uPk], urMaxAt: label(uPk), urLag: uPk - t,
        after6: fwd(t, 6), after12: fwd(t, 12), recovered: rec == null ? null : label(rec), recoverMonths: rec == null ? null : rec - t };
    });
    const normal = [], crisis = [];
    for(let i = 0; i < n; i++) (inCrisis.has(i) ? crisis : normal).push(i);
    const f12 = I => I.map(i => fwd(i, 12)).filter(x => x != null);
    const summ = I => { const f = f12(I); return { months: I.length, vixAvg: mean(I.map(i => va[i])),
      urAvg: mean(I.map(i => ur[i]).filter(x => x != null)), after12: f.length ? median(f) : null, up12: f.length ? f.filter(x => x > 0).length / f.length : null }; };
    const zones = ZONES.map(z => { const I = []; for(let i = 0; i < n; i++) if(va[i] >= z[0] && va[i] < z[1]) I.push(i);
      const f = f12(I); return { lo: z[0], hi: z[1], months: I.length, counted: f.length, median12: median(f), up12: f.filter(x => x > 0).length / f.length,
        worst12: Math.min.apply(null, f), best12: Math.max.apply(null, f), list: I.map(label) }; });
    return { first: label(0), last: label(n - 1), crises: rows, normal: summ(normal), crisis: summ(crisis), zones };
  }
  window.btStats = btStats; window.BT_DATA = BT_DATA; window.BT_CRISES = BT_CRISES;   // tests

  const tr = window.tr || ((th) => th);
  const pct = (x, d) => x == null ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d == null ? 0 : d) + '%';
  const cls = x => x == null ? '' : x < 0 ? 'neg' : 'pos';
  const ym = s => { const [y, m] = s.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString((window.GI_LOCALE || 'th-TH') + '-u-ca-gregory', { month: 'short', year: 'numeric' }); };

  function render(){
    const S = btStats(BT_DATA, BT_CRISES);
    const el = id => document.getElementById(id);
    if(!el('btCrisis')) return;
    el('btCrisis').innerHTML = '<thead><tr><th>' + tr('ช่วง', 'Period') + '</th><th>' + tr('S&P 500 ลงสุด', 'S&P 500 fall') + '</th><th>VIX ' + tr('ตอนเริ่ม', 'at start') + '</th><th>VIX ' + tr('เฉลี่ย', 'average') + '</th><th>VIX ' + tr('สูงสุด', 'high') + '</th><th>' + tr('ว่างงาน', 'Unemployment') + '</th><th>' + tr('12 เดือนหลังก้น', '12 months after bottom') + '</th><th>' + tr('กลับยอดเดิม', 'Back to peak') + '</th></tr></thead><tbody>'
      + S.crises.map(r => '<tr><td><b>' + tr(r.th, r.en) + '</b><small>' + ym(r.peak) + ' → ' + ym(r.trough) + ' · ' + r.months + ' ' + tr('เดือน', 'mo') + '</small></td>'
        + '<td class="neg">' + pct(r.drawdown, 1) + '</td><td>' + r.vixAtPeak.toFixed(1) + '</td><td>' + r.vixAvg.toFixed(1) + '</td><td>' + r.vixMax.toFixed(1) + '</td>'
        + '<td>' + r.urStart.toFixed(1) + '% → ' + r.urMax.toFixed(1) + '%<small>' + tr('สูงสุด ', 'top ') + ym(r.urMaxAt) + '</small></td>'
        + '<td class="' + cls(r.after12) + '">' + pct(r.after12, 1) + '</td><td>' + (r.recovered ? r.recoverMonths + ' ' + tr('เดือน', 'mo') + '<small>' + ym(r.recovered) + '</small>' : '–') + '</td></tr>').join('')
      + '<tr class="bt-normal"><td><b>' + tr('ช่วงปกติ (เดือนที่เหลือทั้งหมด)', 'Normal times (all other months)') + '</b><small>' + S.normal.months + ' ' + tr('เดือน', 'months') + '</small></td><td>–</td><td>–</td><td>' + S.normal.vixAvg.toFixed(1) + '</td><td>–</td><td>' + tr('เฉลี่ย ', 'avg ') + S.normal.urAvg.toFixed(1) + '%</td>'
      + '<td class="' + cls(S.normal.after12) + '">' + pct(S.normal.after12, 1) + '<small>' + tr('ค่ากลาง', 'median') + '</small></td><td>–</td></tr></tbody>';

    el('btZones').innerHTML = '<thead><tr><th>' + tr('VIX เฉลี่ยในเดือนนั้น', 'Month\'s average VIX') + '</th><th>' + tr('จำนวนเดือน', 'Months') + '</th><th>' + tr('ค่ากลาง 12 เดือนต่อมา', 'Median, 12 months on') + '</th><th>' + tr('ขึ้นกี่ %', 'Share up') + '</th><th>' + tr('แย่สุด', 'Worst') + '</th><th>' + tr('ดีสุด', 'Best') + '</th></tr></thead><tbody>'
      + S.zones.map(z => '<tr><td><b>' + (z.hi === Infinity ? '≥ ' + z.lo : z.lo === 0 ? '< ' + z.hi : z.lo + '–' + z.hi) + '</b></td><td>' + z.months + '</td><td class="' + cls(z.median12) + '">' + pct(z.median12, 1) + '</td><td>' + Math.round(z.up12 * 100) + '%</td><td class="' + cls(z.worst12) + '">' + pct(z.worst12) + '</td><td class="' + cls(z.best12) + '">' + pct(z.best12) + '</td></tr>').join('') + '</tbody>';

    const top = S.zones[S.zones.length - 1], mid = S.zones[2];
    const lowStart = Math.max.apply(null, S.crises.map(r => r.vixAtPeak));
    // only crises where joblessness clearly rose (1+ point); in 2022 it barely moved
    const lags = S.crises.filter(r => r.urMax - r.urStart >= 1).map(r => r.urLag);
    const lagMin = Math.min.apply(null, lags), lagMax = Math.max.apply(null, lags);
    el('btPoints').innerHTML = [
      tr('ก่อนตลาดเริ่มลง VIX ยังไม่ส่งสัญญาณ: ตอนยอดของทุกวิกฤต VIX เฉลี่ยไม่เกิน ' + lowStart.toFixed(1) + ' มันพุ่งตอนที่ตลาดลงไปมากแล้ว',
        'VIX gave no early warning: at every crisis peak its monthly average was ' + lowStart.toFixed(1) + ' or lower. It jumps once the fall is well under way.'),
      tr('VIX เฉลี่ยรายเดือน ≥ 40 มีแค่ ' + top.months + ' เดือน (2008–09 และ 2020) และอีก 12 เดือนต่อมา S&P 500 ขึ้นทุกครั้ง ค่ากลาง ' + pct(top.median12) + ' แต่ตัวอย่างน้อยมาก',
        'A monthly average VIX of 40 or more happened in only ' + top.months + ' months (2008–09 and 2020), and the S&P 500 was higher 12 months later every time, median ' + pct(top.median12) + '. That is a very small sample.'),
      tr('โซน 20–25 ขึ้นแค่ ' + Math.round(mid.up12 * 100) + '% ของครั้ง แย่สุด ' + pct(mid.worst12) + ' เพราะเป็นช่วงที่ตลาดเริ่มกังวลแต่ยังไม่ถึงก้น',
        'The 20–25 zone was up only ' + Math.round(mid.up12 * 100) + '% of the time, worst ' + pct(mid.worst12) + ': worry is building but the bottom is often still ahead.'),
      tr('อัตราว่างงานขึ้นช้ากว่าตลาด: ในวิกฤตที่คนตกงานเพิ่มชัดเจน จุดสูงสุดมาหลังก้นของ S&P 500 ' + lagMin + '–' + lagMax + ' เดือน รอให้ว่างงานดีขึ้นก่อนค่อยซื้อมักจะช้าไป',
        'Unemployment lags the market: in the crises where it clearly rose, it peaked ' + lagMin + '–' + lagMax + ' months after the S&P 500 bottom, so waiting for jobs to improve usually meant buying late.')
    ].map(s => '<li>' + s + '</li>').join('');

    el('btNote').innerHTML = tr('ข้อมูลรายเดือน ' + ym(S.first) + ' – ' + ym(S.last) + ' (เดือนล่าสุดยังไม่จบ จึงไม่นับเป็นผล 12 เดือน) · VIX: FRED VIXCLS (เฉลี่ยราคาปิดรายวันในเดือน, "สูงสุด" = ราคาปิดรายวันสูงสุด) · ว่างงาน: FRED UNRATE (ต.ค. 2025 ไม่มีตัวเลข) · S&P 500: ราคาปิดสิ้นเดือน ไม่รวมเงินปันผล · ยอด/ก้น ใช้ราคาปิดสิ้นเดือน จึงลงน้อยกว่าตัวเลขรายวันเล็กน้อย · เดือนที่ซ้อนกันทำให้ผล 12 เดือนไม่อิสระต่อกัน · อดีตไม่ได้บอกอนาคต',
      'Monthly data ' + ym(S.first) + ' – ' + ym(S.last) + ' (the latest month is unfinished, so it is not used as a 12-month result) · VIX: FRED VIXCLS (average of daily closes in the month; "high" = highest daily close) · Unemployment: FRED UNRATE (no figure for Oct 2025) · S&P 500: month-end close, price only, no dividends · Peaks and bottoms use month-end closes, so falls look a little smaller than on daily data · Overlapping 12-month windows are not independent · The past does not predict the future');

    drawChart(el('btChart'), S);
  }

  // Hover / tap on a backtest chart: vertical line, a dot per series, and a box with the date, the
  // values and the name of the shaded period under the cursor. Shared by the S&P 500 and BTC charts.
  function btHover(box, o){
    const svg = box.querySelector('svg'); if(!svg || !svg.addEventListener) return;
    const NS = 'http://www.w3.org/2000/svg', mk = (t, a) => { const e = document.createElementNS(NS, t); for(const k in a) e.setAttribute(k, a[k]); return e; };
    const g = mk('g', { visibility: 'hidden' }), line = mk('line', { y1: o.T, y2: o.H - o.B, stroke: '#eef3ff', 'stroke-opacity': '.45', 'stroke-dasharray': '2 3' });
    g.appendChild(line);
    const dots = o.series.map(sr => { const c = mk('circle', { r: 4, fill: sr.color, stroke: '#0b1020', 'stroke-width': 1.5 }); g.appendChild(c); return c; });
    svg.appendChild(g);
    const tip = document.createElement('div'); tip.className = 'bt-tip'; box.appendChild(tip);
    function show(ev){
      const r = svg.getBoundingClientRect(); if(!r.width) return;
      const sx = (ev.clientX - r.left) * o.W / r.width;
      const i = Math.max(0, Math.min(o.n - 1, Math.round((sx - o.L) / (o.W - o.L - o.R) * (o.n - 1))));
      const px = o.x(i);
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      o.series.forEach((sr, k) => { const v = sr.values[i]; dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible'); if(v != null){ dots[k].setAttribute('cx', px); dots[k].setAttribute('cy', sr.y(v)); } });
      g.setAttribute('visibility', 'visible');
      const band = o.bands.filter(b => i >= b.from && i <= b.to)[0];
      tip.innerHTML = '<div class="d">' + o.label(i) + '</div>' + (band ? '<div class="cr">' + band.name + '</div>' : '')
        + o.series.map(sr => sr.values[i] == null ? '' : '<div><i style="background:' + sr.color + '"></i>' + sr.name + ' <b>' + sr.fmt(sr.values[i]) + '</b></div>').join('')
        + (o.extra ? o.extra(i) : '');
      tip.style.display = 'block';
      const bx = box.getBoundingClientRect(), cx = ev.clientX - bx.left + box.scrollLeft, w = tip.offsetWidth;
      tip.style.left = Math.max(box.scrollLeft + 4, cx + 14 + w > box.scrollLeft + bx.width ? cx - 14 - w : cx + 14) + 'px';
    }
    function hide(){ g.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
    // a finger lifting fires pointerleave, so on touch the box stays until a tap elsewhere
    svg.addEventListener('pointerleave', ev => { if(ev.pointerType !== 'touch') hide(); });
    document.addEventListener('pointerdown', ev => { if(!svg.contains(ev.target)) hide(); });
  }
  window.btHover = btHover;
  document.querySelectorAll('#backtestTab .bt-nav button').forEach(btn => btn.addEventListener('click', () => {
    const t = document.getElementById(btn.dataset.go); if(t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  function drawChart(box, S){
    const d = BT_DATA, n = d.spx.length, W = 900, H = 300, L = 40, R = 40, T = 10, B = 22;
    const x = i => L + (W - L - R) * i / (n - 1);
    const lo = Math.log(Math.min.apply(null, d.spx)), hi = Math.log(Math.max.apply(null, d.spx));
    const yS = v => T + (H - T - B) * (1 - (Math.log(v) - lo) / (hi - lo));
    const yV = v => T + (H - T - B) * (1 - Math.min(v, 70) / 70);
    const idx = s => (+s.slice(0, 4) - 1990) * 12 + (+s.slice(5, 7) - 1);
    let g = S.crises.map(r => '<rect x="' + x(idx(r.peak)).toFixed(1) + '" y="' + T + '" width="' + Math.max(3, x(idx(r.trough)) - x(idx(r.peak))).toFixed(1) + '" height="' + (H - T - B) + '" fill="rgba(255,101,119,.16)"/>').join('');
    [10, 20, 40].forEach(v => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yV(v) + '" y2="' + yV(v) + '" stroke="#24304a" stroke-dasharray="3 4"/><text x="' + (W - R + 4) + '" y="' + (yV(v) + 3) + '" fill="#ff6577" font-size="10">' + v + '</text>'; });
    [500, 1000, 2000, 4000].forEach(v => { g += '<text x="' + (L - 4) + '" y="' + (yS(v) + 3) + '" fill="#d4b26a" font-size="10" text-anchor="end">' + v + '</text>'; });
    for(let y = 1990; y <= 2025; y += 5) g += '<text x="' + x((y - 1990) * 12) + '" y="' + (H - 6) + '" fill="#8e9bb5" font-size="10" text-anchor="middle">' + y + '</text>';
    const path = (arr, fy) => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + fy(v).toFixed(1)).join('');
    g += '<path d="' + path(d.va, yV) + '" fill="none" stroke="#ff6577" stroke-width="1.2" opacity=".85"/>';
    g += '<path d="' + path(d.spx, yS) + '" fill="none" stroke="#d4b26a" stroke-width="2"/>';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + tr('กราฟ S&P 500 และ VIX ตั้งแต่ 1990', 'S&P 500 and VIX since 1990') + '">' + g + '</svg>';
    const t0 = +d.start.slice(0, 4) * 12 + (+d.start.slice(5, 7)) - 1, lab = i => Math.floor((t0 + i) / 12) + '-' + String((t0 + i) % 12 + 1).padStart(2, '0');
    btHover(box, { W, H, L, R, T, B, n, x,
      label: i => ym(lab(i)),
      bands: S.crises.map(r => ({ from: idx(r.peak), to: idx(r.trough), name: tr(r.th, r.en) + ' · ' + pct(d.spx[idx(r.trough)] / d.spx[idx(r.peak)] - 1, 1) })),
      series: [
        { name: 'S&P 500', color: '#d4b26a', values: d.spx, y: yS, fmt: v => v.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
        { name: tr('VIX (เฉลี่ยเดือน)', 'VIX (month avg)'), color: '#ff6577', values: d.va, y: yV, fmt: v => v.toFixed(1) }
      ],
      extra: i => '<div class="d">' + tr('VIX สูงสุดในเดือน ', 'VIX month high ') + (d.vm[i] != null ? d.vm[i].toFixed(1) : '–') + (d.ur[i] != null ? ' · ' + tr('ว่างงาน ', 'unemployment ') + d.ur[i].toFixed(1) + '%' : '') + '</div>' });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
