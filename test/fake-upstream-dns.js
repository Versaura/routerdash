// Fake upstream: answers every A query with 1.2.3.4
const d=require('dgram').createSocket('udp4');
d.on('message',(m,r)=>{const a=Buffer.from(m);a[2]=0x81;a[3]=0x80;a.writeUInt16BE(1,6);const ans=Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,1,2,3,4]);d.send(Buffer.concat([a,ans]),r.port,r.address)});
d.bind(Number(process.env.FAKE_DNS_PORT||53),'127.0.0.1',()=>console.log('fake dns up'));
