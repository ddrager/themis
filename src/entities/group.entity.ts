import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToMany, OneToMany, ManyToOne, OneToOne, JoinColumn } from 'typeorm';
import { Post } from './post.entity';
import { Activity } from './activity.entity';
import { Server } from './server.entity';
import { User } from './user.entity';
import { ActorEntity } from './actor.entity';

/**
 * A Group represents a group in the database. This is
 * where we keep the name, description, etc., for them,
 * and we've got relations for posts and the rest.
 * 
 * Note that we have to change the table name because
 * "group" is a reserved word in SQL.
 *
 * @export
 * @class Group
 */
@Entity("groups")
export class Group {
    @PrimaryGeneratedColumn()
    id: number;

    /**
     * `name` is the canonical name for the group.
     * It's required, and it is local to the server.
     * TODO: What is a good length for this? We don't want it to be too long,
     * since it's used to generate @-names. We'll start with 60 for now.
     *
     * @memberof Group
     */
    @Column('varchar', { length: 60 })
    name: string;

    /**
     * `server` is the name of the server hosting this group.
     * Groups are local to the server; IOW, multiple servers can all
     * have a group named "foo", and these would be separate.
     *
     * @memberof Group
     */
    @ManyToOne(type => Server, server => server.groups, { eager: true })
    server: Server;

    /**
     * `displayName` is a public name for the group.
     * It's not entirely necessary, but it's a useful parallel to users.
     *
     * @memberof Group
     */
    @Column('text', { nullable: true })
    displayName: string;

    /**
     * `summary` is a brief description of the group's purpose.
     * This is mostly to match users, but it could also be useful to list
     * things like allowed topics, moderation (if we add that), etc.
     *
     * @memberof Group
     */
    @Column('text', { nullable: true })
    summary: string;

    /**
     * Collection of posts in this group. Mostly used for easier DB access.
     *
     * @memberof Group
     */
    @ManyToMany(type => Post, post => post.groups)
    posts: Post[];

    /**
     * The activities in this group's outbox
     *
     * @memberof Group
     */
    @OneToMany(type => Activity, activity => activity.sourceGroup)
    outbox: Activity[];

    /**
     * The activities in this group's inbox
     *
     * @memberof Group
     */
    @ManyToMany(type => Activity, activity => activity.destinationGroups)
    inbox: Activity[];

    /**
     * 'uri' is a unique identifying URI for this group, used in the
     * ActivityPub portion of Themis.
     *
     * @memberof Group
     */
    @Column({ nullable: true })
    uri: string;
    
    /**
     * We'll also store the date the group was created.
     * This isn't as necessary as for users, but it might come in handy.
     *
     * @memberof Group
     */
    @CreateDateColumn({readonly: true })
    date: string;

    /**
     * All the users following this group.
     *
     * @memberof Group
     */
    @ManyToMany(type => User, user => user.groupFollowing)
    followingUsers: User[];

    /**
     * This group's Actor object, for use with the ActivityPub layer.
     *
     * @memberof Group
     */
    @OneToOne(type => ActorEntity, { cascade: true, eager: true })
    @JoinColumn()
    actor: ActorEntity;
}