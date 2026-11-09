import type {NextConfig} from 'next';

const config:NextConfig={
  poweredByHeader:false,
  devIndicators:false,
  async redirects(){return [
    {source:'/index.html',destination:'/',permanent:false},
    {source:'/design.html',destination:'/',permanent:false},
  ];},
};
export default config;
